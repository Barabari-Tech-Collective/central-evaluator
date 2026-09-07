import { generateAIFeedback } from "../react/utils/aiFeedback.js";
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
 * Recursively reads .html, .css, .js files from a directory,
 * ignoring node_modules, .git, and common asset folders.
 */
async function readProjectFiles(dir, fileList = []) {
  const IGNORED_DIRS = new Set(["node_modules", ".git", "public", "assets", "images", "img"]);
  const ALLOWED_EXTENSIONS = new Set([".html", ".css", ".js"]);

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
 * Compresses source code to reduce AI token usage.
 */
function compressCode(code) {
  let compressed = code.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
  compressed = compressed.replace(/^\s*[\r\n]/gm, "");
  compressed = compressed.replace(/[ \t]{2,}/g, " ");
  return compressed;
}

/**
 * Reads all relevant source files from the student project and returns
 * a concatenated string for AI analysis.
 */
async function getProjectCodeString(projectPath) {
  let files = await readProjectFiles(projectPath);

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

function parseRubric(rubricData) {
  if (typeof rubricData === 'string') {
    try {
      rubricData = JSON.parse(rubricData);
    } catch (e) {
      // It's a raw string, we'll try to parse it as text
      const lines = rubricData.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 3);
      const items = [];
      for (const line of lines) {
        const weightMatch = line.match(/\((\d+)\s*(?:pts?|points?|marks?|%)\)/i) ||
                            line.match(/\[(\d+)\s*(?:pts?|points?|marks?|%)\]/i) ||
                            line.match(/(\d+)\s*(?:pts?|points?|marks?)\s*[-:]/i);
        const weight = weightMatch ? parseInt(weightMatch[1], 10) : 20;
        const name = line.replace(/^\d+[\.\)]\s*/, '').replace(/^[-*•]\s*/, '').trim();
        if (name) items.push({ name, weight, description: name });
      }
      return items.length > 0 ? { criteria: items } : { criteria: [
        { name: 'HTML Structure & Markup', weight: 25, description: 'HTML layout and structure' },
        { name: 'CSS Styling & Design', weight: 25, description: 'CSS stylesheet styling' },
        { name: 'JavaScript Functionality', weight: 50, description: 'JavaScript DOM interactivity' }
      ]};
    }
  }
  
  // Handle already parsed object
  if (rubricData && rubricData.criteria) return rubricData;
  if (rubricData && Array.isArray(rubricData)) return { criteria: rubricData };
  return { criteria: [] };
}

/**
 * Scores a Visual (HTML/CSS/JS) submission using AI-based code analysis.
 */
export default async function scoreSubmission(rawRubric, projectPath, githubReport) {
  const warnings = [];
  const rubric = parseRubric(rawRubric);

  const codeString = await getProjectCodeString(projectPath);

  let breakdown = {};
  let reasons = {};
  let multipliers = {};
  let totalScore = 0;

  if (!codeString) {
    logger.warn("No source files found in student repo.");
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

  const criteriaList = rubric.criteria
    .map((c, i) => `${i + 1}. "${c.name}" (weight: ${c.weight} points): ${c.description || "No description provided."}`)
    .join("\n");

  const groq = getGroqClient();

  if (!groq) {
    logger.error("Groq client unavailable — OPENAI_API_KEY is not set.");
    throw new Error("AI grading client unavailable. Please check your API keys.");
  } else {
    const prompt = `You are an expert web development instructor grading a student's HTML/CSS/JS assignment.

## GitHub Actions Syntax Report:
${githubReport || "No report available."}

## Student's Compressed Source Code:
${codeString}

## Rubric Criteria to Evaluate:
${criteriaList}

## Grading Instructions:
You must be an extremely strict, objective, and unforgiving grader. 
Read the source code carefully to determine if the functionality requested in the rubric actually exists.
Pay close attention to whether the HTML actually links to the CSS (<link>) and JS (<script>). If they are not linked, the student cannot receive full marks for functionality that depends on them.

Assign a score multiplier between 0.0 and 1.0 for EACH criterion:
- 1.0 = Fully meets all exact requirements for this criterion (code is fully functional and linked correctly)
- 0.7-0.9 = Mostly correct with minor gaps or sloppy code
- 0.4-0.6 = Partial implementation of the exact feature
- 0.1-0.3 = Bare minimum skeleton of the exact feature
- 0.0 = Not attempted, completely missing, or completely unrelated project

For EACH criterion write a detailed 2-3 sentence reasoning that:
1. States specifically what was FOUND in the source code files (cite actual code, class names, or logic).
2. States specifically what is MISSING or WRONG compared to the rubric requirements.

Output STRICTLY a JSON object (no markdown, no extra text):
{
  "scores": [
    { "name": "<exact criterion name>", "multiplier": <number 0.0-1.0>, "reasoning": "<2-3 sentence code-specific explanation>" }
  ]
}`;

    try {
      logger.info("Sending code to Groq AI for visual rubric scoring...");

      const response = await groq.chat.completions.create({
        model: process.env.OPENAI_MODEL || "deepseek-v4-flash",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 1000,
        temperature: 0.1,
        response_format: { type: "json_object" },
      });

      const rawContent = response.choices[0]?.message?.content?.trim();
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
          }
        }
      }

      // Fill in any criteria that the AI missed
      for (const c of rubric.criteria) {
        if (breakdown[c.name] === undefined) {
          warnings.push(`AI did not return a score for "${c.name}" — defaulting to 0.`);
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

  const maxScore = rubric.criteria.reduce((sum, c) => sum + c.weight, 0);
  const status = totalScore >= maxScore * 0.5 ? "pass" : "fail";

  logger.info(`Generating visual feedback for total score: ${totalScore}/${maxScore}`);
  const feedbackText = await generateAIFeedback({
    rubric_breakdown: breakdown,
    rubric_criteria: rubric.criteria,
    per_criterion_reasons: reasons,
    score: totalScore,
    warnings,
    execution_logs: githubReport || "",
  });

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
