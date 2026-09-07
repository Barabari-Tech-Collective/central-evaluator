import { generateAIFeedback } from "./utils/aiFeedback.js";
import logger from "../../config/logger.js";
import fs from "fs/promises";
import path from "path";
import OpenAI from "openai";

let client = null;

function getGroqClient() {
  if (client) return client;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logger.warn("OPENAI_API_KEY not set — AI scoring will fail.");
    return null;
  }
  client = new OpenAI({
    apiKey,
    baseURL: process.env.OPENAI_BASE_URL || 'https://api.deepseek.com',
  });
  return client;
}

/**
 * Recursively reads .js, .jsx, .ts, .tsx files from a directory,
 * ignoring node_modules, dist, build, .git, and .css to save tokens.
 */
async function readProjectFiles(dir, fileList = []) {
  const IGNORED_DIRS = new Set(["node_modules", "dist", "build", ".git", ".next", "public", "assets"]);
  const ALLOWED_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".css"]);

  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch {
    return fileList;
  }

  for (const entry of entries) {
    const filePath = path.join(dir, entry);
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat) continue;

    if (stat.isDirectory()) {
      if (!IGNORED_DIRS.has(entry)) {
        await readProjectFiles(filePath, fileList);
      }
    } else if (ALLOWED_EXTENSIONS.has(path.extname(entry).toLowerCase())) {
      fileList.push(filePath);
    }
  }
  return fileList;
}

/**
 * Compresses source code to drastically reduce AI token usage.
 */
function compressCode(code) {
  // Remove block comments (/* ... */) and single-line comments (// ...)
  let compressed = code.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
  // Remove empty lines and excessive indentation
  compressed = compressed.replace(/^\s*[\r\n]/gm, "");
  compressed = compressed.replace(/[ \t]{2,}/g, " ");
  return compressed;
}

/**
 * Reads all relevant source files from the student project and returns
 * a concatenated string for AI analysis.
 *
 * @param {string} projectPath - Path to the cloned student repo
 * @returns {Promise<string>} - Concatenated compressed code string
 */
async function getProjectCodeString(projectPath) {
  // Try src/ first, then fall back to root
  const srcDir = path.join(projectPath, "src");
  let files = [];
  try {
    files = await readProjectFiles(srcDir);
  } catch {
    // No src/ directory, try root
  }

  if (files.length === 0) {
    files = await readProjectFiles(projectPath);
  }

  // Cap at 15 files to avoid token overflow
  files = files.slice(0, 15);

  if (files.length === 0) {
    return "";
  }

  let codeStr = "";
  for (const f of files) {
    const relativePath = path.relative(projectPath, f);
    try {
      const content = await fs.readFile(f, "utf8");
      const compressed = compressCode(content);
      // Cap each file at 2000 compressed chars to be ultra token efficient
      codeStr += `\n--- ${relativePath} ---\n${compressed.slice(0, 2000)}\n`;
    } catch {
      // Skip unreadable files
    }
  }

  return codeStr;
}

/**
 * Helper to compute evaluation score from Vitest JSON report.
 */
function scoreFromTestResults(rubric, testResults) {
  if (!testResults || testResults.error || !Array.isArray(testResults.testResults)) {
    return null;
  }
  const assertions = testResults.testResults?.[0]?.assertionResults || [];
  if (assertions.length === 0) {
    return null;
  }

  const breakdown = {};
  const reasons = {};
  const multipliers = {};
  let totalScore = 0;

  // Group tests by rubric name prefix
  const categoryStats = {};
  for (const c of rubric.criteria) {
    categoryStats[c.name] = { passed: 0, total: 0, failedDetails: [] };
  }

  for (const assertion of assertions) {
    const title = assertion.title || "";
    const status = assertion.status; // "passed" or "failed"
    
    // Find matching rubric
    let matchedCriterion = null;
    for (const c of rubric.criteria) {
      if (title.toLowerCase().startsWith(c.name.toLowerCase())) {
        matchedCriterion = c.name;
        break;
      }
    }

    if (matchedCriterion) {
      categoryStats[matchedCriterion].total++;
      if (status === "passed") {
        categoryStats[matchedCriterion].passed++;
      } else {
        const cleanedError = (assertion.failureMessages?.[0] || "Test assertion failed")
          .split('\n')[0] // Only get the first line of the error to keep it simple and clean
          .replace(/\x1B\[\d+m/g, ""); // Strip ANSI colors
        categoryStats[matchedCriterion].failedDetails.push(cleanedError);
      }
    }
  }

  // Calculate scores
  for (const c of rubric.criteria) {
    const stats = categoryStats[c.name];
    if (stats && stats.total > 0) {
      const multiplier = stats.passed / stats.total;
      const score = Math.round(multiplier * c.weight);
      breakdown[c.name] = score;
      multipliers[c.name] = Math.round(multiplier * 10) / 10;
      
      if (stats.failedDetails.length === 0) {
        reasons[c.name] = `Passed all ${stats.total} unit tests.`;
      } else {
        reasons[c.name] = `Failed ${stats.failedDetails.length}/${stats.total} tests. Errors: ${stats.failedDetails.join('; ')}`;
      }
    } else {
      breakdown[c.name] = 0;
      multipliers[c.name] = 0.0;
      reasons[c.name] = "No tests found or executed for this criterion.";
    }
    totalScore += breakdown[c.name];
  }

  return {
    score: totalScore,
    rubric_breakdown: breakdown,
    reasons,
    multipliers
  };
}

/**
 * Scores a React submission using AI-based code analysis.
 * Reads the student's actual source code and evaluates each rubric criterion
 * using Groq AI.
 *
 * @param {Object} rubric      - { criteria: [{ name, weight, description }] }
 * @param {string} projectPath - Path to the cloned student repo
 * @param {string} githubReport - Build/Linter report from GitHub Actions
 * @param {Object} testResults - Test suite results JSON
 * @returns {Promise<Object>}  - Standard evaluation output
 */
export default async function scoreSubmission(rubric, projectPath, githubReport, testResults) {
  const warnings = [];

  // Step 1: Read the student's code (compressed for tokens)
  const codeString = await getProjectCodeString(projectPath);

  if (!codeString) {
    logger.warn("No source files found in student repo.");
    const breakdown = {};
    for (const c of rubric.criteria) {
      breakdown[c.name] = 0;
    }
    const feedback = await generateAIFeedback({
      rubric_breakdown: breakdown,
      score: 0,
      warnings: ["No source files found in the repository."],
      execution_logs: githubReport || "",
    });
    return {
      score: 0,
      rubric_breakdown: breakdown,
      feedback,
      warnings: ["No source files found in the repository."],
      execution_logs: githubReport || "",
      status: "fail",
    };
  }

  // Check if we can grade via Vitest test results mathematically (Option A)
  const testGrading = scoreFromTestResults(rubric, testResults);
  let breakdown = {};
  let reasons = {};
  let multipliers = {};
  let totalScore = 0;
  let gradedByTests = false;

  if (testGrading) {
    logger.info("Deterministic testResults found. Grading React Todo mathematically based on Vitest outcomes.");
    breakdown = testGrading.rubric_breakdown;
    reasons = testGrading.reasons;
    multipliers = testGrading.multipliers;
    totalScore = testGrading.score;
    gradedByTests = true;
  }

  if (!gradedByTests) {
    // Step 2: Build the rubric criteria description for the AI prompt
    const criteriaList = rubric.criteria
      .map(
        (c, i) =>
          `${i + 1}. "${c.name}" (weight: ${c.weight} points): ${c.description || "No description provided."}`
      )
      .join("\n");

    // Step 3: Ask AI to score each criterion
    const groq = getGroqClient();

    if (!groq) {
      logger.error("Groq client unavailable — OPENAI_API_KEY is not set.");
      throw new Error("AI grading client unavailable. Please check your API keys.");
    } else {
      const prompt = `You are an expert React instructor grading a student's assignment.

## Assignment Requirements:
This is a Todo List application. Students must:
- Create an App.jsx parent component that renders a Todo child component
- Use useState for tasks (array of objects with id, text, completed) and newTask (string)
- Implement handleChange (input updates), handleAdd (adds task), handleCheck (toggles completed), handleDelete (removes task)
- Dynamically render tasks with .map(), apply 'check' CSS class for completed items

## GitHub Actions Build/Linter Report:
${githubReport || "No build report available."}

## Student's Compressed Source Code:
${codeString}

## Rubric Criteria to Evaluate:
${criteriaList}

## Grading Instructions:
You must be an extremely strict, objective, and unforgiving grader. Students must only receive marks for implementing the EXACT requirements of the Todo List assignment.

CRITICAL RULES:
1. ASSIGNMENT RELEVANCE CHECK: Check if the submission is actually a Todo List application.
   - If the student submitted a completely different project (e.g. an Authentication page, a counter, a routing project, or a calculator), they MUST receive 0 marks for ALL criteria (Project Setup can get max 2 marks for basic React setup, all other criteria must be strictly 0).
   - Do NOT give partial credit for "demonstrating state management" or "setting up components" using unrelated code (e.g., AuthContext, login forms, etc.). If the Todo app features are absent, the score is 0.

2. CRITERION SPECIFICS:
    - 'Project Setup & Architecture' (Max 15): If 'todo.jsx' component is missing, or not rendered as a child of 'App.jsx', award max 2 marks.
    - 'State Management' (Max 20): Specifically look for 'tasks' state (array of objects) and 'newTask' state (string). If these exact states are missing, award 0.
    - 'Input Handling' (Max 25): Look for 'handleChange' and 'handleAdd'. If missing, award 0. If they don't prevent empty inputs, deduct 5 marks.
    - 'Task Completion & Deletion' (Max 25): Look for 'handleCheck' and 'handleDelete' functions. If both are missing, award 0. If one is missing, award max 10.
    - 'UI Structure & CSS Styling' (Max 15): Look for '.map()' rendering tasks, checkbox toggle, and conditional application of the 'check' class (e.g. className={task.completed ? 'check' : ''}). Check the CSS files for '.check' styling (e.g. text-decoration: line-through). If the class is missing from JSX or CSS, award max 5 marks.

3. BUILD FAILURE RULE:
   - If the Build Report says "Build: Failed" or "failed to compile", they can STILL get partial credit for criteria that are fully correct in the source code (Setup, State, Input, Completion/Deletion).
   - However, "UI Structure & CSS Styling" must be capped at max 5 marks if the build failed, as we cannot verify dynamic rendering at runtime.

Assign a score multiplier between 0.0 and 1.0:
- 1.0 = Fully meets all exact requirements for this criterion
- 0.7-0.9 = Correct with minor gaps (e.g. missing empty-input check, or linter warnings)
- 0.4-0.6 = Partial implementation of the exact feature
- 0.1-0.3 = Bare minimum skeleton of the exact feature
- 0.0 = Not attempted, completely missing, or irrelevant project code

For EACH criterion write a detailed 2-3 sentence reasoning that:
1. States specifically what was FOUND in the source code files (cite actual code, function/state names, or lines).
2. States specifically what is MISSING or WRONG compared to the rubric requirements.
3. Mentions if the build failed and how it affected that specific criterion.

Output STRICTLY a JSON object (no markdown, no extra text):
{
  "scores": [
    { "name": "<exact criterion name>", "multiplier": <number 0.0-1.0>, "reasoning": "<2-3 sentence code-specific explanation>" }
  ]
}`;



    try {
      logger.info("Sending code to Groq AI for rubric-based scoring...");

      const response = await groq.chat.completions.create({
        model: process.env.OPENAI_MODEL || "deepseek-v4-flash",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 1000,
        temperature: 0.1,
        response_format: { type: "json_object" },
      });

      const rawContent = response.choices[0]?.message?.content?.trim();
      logger.info(`Groq AI response received: ${rawContent?.slice(0, 200)}...`);

      const parsed = JSON.parse(rawContent);

      if (parsed.scores && Array.isArray(parsed.scores)) {
        for (const scoredCriteria of parsed.scores) {
          const matchingRubric = rubric.criteria.find(
            (c) => c.name.toLowerCase() === scoredCriteria.name?.toLowerCase()
          );

          if (matchingRubric) {
            const multiplier =
              typeof scoredCriteria.multiplier === "number"
                ? Math.max(0, Math.min(1, scoredCriteria.multiplier))
                : 0;
            const score = Math.round(matchingRubric.weight * multiplier);
            breakdown[matchingRubric.name] = score;
            reasons[matchingRubric.name] = scoredCriteria.reasoning || "Passed requirements.";
            multipliers[matchingRubric.name] = multiplier;
            totalScore += score;

            if (scoredCriteria.reasoning) {
              logger.info(
                `  "${matchingRubric.name}": ${score}/${matchingRubric.weight} — ${scoredCriteria.reasoning}`
              );
            }
          }
        }
      }

      // Fill in any criteria that the AI missed
      for (const c of rubric.criteria) {
        if (breakdown[c.name] === undefined) {
          warnings.push(
            `AI did not return a score for "${c.name}" — defaulting to 0.`
          );
          breakdown[c.name] = 0;
          reasons[c.name] = "AI analysis failed or missed this criterion.";
          multipliers[c.name] = 0.0;
        }
      }
    } catch (err) {
      logger.error(`AI scoring failed: ${err.message}`);
      throw new Error(`AI scoring error: ${err.message}`);
    }
  }
}

  const maxScore = rubric.criteria.reduce((sum, c) => sum + c.weight, 0);
  const status = totalScore >= maxScore * 0.5 ? "pass" : "fail";

  // Step 4: Generate human-readable AI feedback (now with full per-criterion context)
  logger.info(`Generating feedback for total score: ${totalScore}/${maxScore}`);
  const feedbackText = await generateAIFeedback({
    rubric_breakdown: breakdown,
    rubric_criteria: rubric.criteria,
    per_criterion_reasons: reasons,
    score: totalScore,
    warnings,
    execution_logs: githubReport || "",
  });

  // Step 5: Construct structured strengths, issues, and breakdown lists
  const strengths = [];
  const issues = [];
  const unifiedBreakdown = [];

  for (const c of rubric.criteria) {
    const awarded = breakdown[c.name] ?? 0;
    const mult = multipliers[c.name] ?? 0.0;
    const reason = reasons[c.name] || "Criterion evaluated by code analysis.";

    unifiedBreakdown.push({
      item: c.name,
      awarded,
      max: c.weight,
      reason
    });

    if (mult === 1.0) {
      strengths.push(`[${c.name}] ${reason} (earned ${awarded}/${c.weight} marks)`);
    } else {
      issues.push(`[${c.name}] ${reason} (earned ${awarded}/${c.weight} marks)`);
    }
  }

  const rubricFeedback = {
    summary: feedbackText || "Evaluation completed successfully.",
    strengths,
    issues,
    breakdown: unifiedBreakdown
  };

  return {
    score: totalScore,
    rubric_breakdown: breakdown,
    feedback: rubricFeedback,
    rubricFeedback: rubricFeedback,
    warnings,
    execution_logs: githubReport || "",
    status,
  };
}