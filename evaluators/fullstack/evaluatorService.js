import OpenAI from 'openai';
import logger from '../../config/logger.js';
import path from 'path';
import fs from 'fs';
import { cloneRepo, deleteRepo } from '../react/repoService.js';
import { scoreFromTestResults } from './scoringService.js';
import { generateFullstackFeedback } from './feedbackService.js';
import { generateAIFeedback } from '../react/utils/aiFeedback.js';

let client = null;

function getClient() {
  if (client) return client;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logger.warn('OPENAI_API_KEY not set - Fullstack AI feedback fallback will fail.');
    return null;
  }
  client = new OpenAI({
    apiKey,
    baseURL: process.env.OPENAI_BASE_URL || 'https://api.deepseek.com',
  });
  return client;
}

/**
 * Recursively reads .js, .jsx, .ts, .tsx, .css, .html, .json files from a directory,
 * ignoring node_modules, dist, build, .git to save tokens.
 */
async function readProjectFiles(dir, fileList = []) {
  const IGNORED_DIRS = new Set(["node_modules", "dist", "build", ".git", ".next", "public", "assets", "coverage"]);
  const ALLOWED_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".css", ".html", ".json", ".sql"]);

  let entries;
  try {
    entries = await fs.promises.readdir(dir);
  } catch {
    return fileList;
  }

  for (const entry of entries) {
    const filePath = path.join(dir, entry);
    const stat = await fs.promises.stat(filePath).catch(() => null);
    if (!stat) continue;

    if (stat.isDirectory()) {
      if (!IGNORED_DIRS.has(entry)) {
        await readProjectFiles(filePath, fileList);
      }
    } else if (ALLOWED_EXTENSIONS.has(path.extname(entry).toLowerCase())) {
      if (entry !== 'package-lock.json') {
        fileList.push(filePath);
      }
    }
  }
  return fileList;
}

function compressCode(code) {
  let compressed = code.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
  compressed = compressed.replace(/^\s*[\r\n]/gm, "");
  compressed = compressed.replace(/[ \t]{2,}/g, " ");
  return compressed;
}

async function getProjectCodeString(projectPath) {
  let files = await readProjectFiles(projectPath);
  files = files.slice(0, 20); // Cap to avoid token overflow

  if (files.length === 0) {
    return "";
  }

  let codeStr = "";
  for (const f of files) {
    const relativePath = path.relative(projectPath, f);
    try {
      const content = await fs.promises.readFile(f, "utf8");
      const compressed = compressCode(content);
      codeStr += `\n--- ${relativePath} ---\n${compressed.slice(0, 2000)}\n`;
    } catch {
      // Skip unreadable files
    }
  }

  return codeStr;
}

/**
 * Evaluates a Full Stack project.
 * Tries mathematical scoring via Playwright test results first.
 * Falls back to AI-based code analysis if test results are absent/failed.
 */
export async function evaluateFullstackProject(payload, jobId, testResults, logs, codeContext = null) {
  const rawCriteria = payload.rubric?.criteria || [];
  const criteria = rawCriteria.map(c => ({
    name: c.name,
    weight: typeof c.weight === 'number' ? c.weight : (typeof c.score === 'number' ? c.score : 20),
    description: c.description || "",
    layer: c.layer || "general"
  }));
  const rubric = { ...payload.rubric, criteria };
  const maxScore = rubric.criteria.reduce((sum, c) => sum + c.weight, 0);

  // 1. Try mathematical scoring if Playwright test results are present
  const testGrading = scoreFromTestResults(rubric, testResults);
  if (testGrading) {
    logger.info(`Deterministic testResults found. Grading Fullstack project mathematically for Job ${jobId}`);

    const status = testGrading.score >= maxScore * 0.5 ? "pass" : "fail";
    
    // Parse Playwright spec details to flat array
    const testDetails = [];
    function recurseSuites(suite) {
      if (Array.isArray(suite.suites)) suite.suites.forEach(recurseSuites);
      if (Array.isArray(suite.specs)) {
        suite.specs.forEach(spec => {
          const testRun = spec.tests?.[0];
          const result = testRun?.results?.[0];
          testDetails.push({
            name: spec.title || "",
            status: (result?.status === "passed") ? "pass" : "fail",
            error: result?.error?.message || null
          });
        });
      }
    }
    if (testResults.suites) {
      testResults.suites.forEach(recurseSuites);
    }

    // Generate technical AI review paragraph
    const feedbackText = await generateFullstackFeedback(testDetails, rubric);

    // Format output to match other evaluators
    const strengths = [];
    const issues = [];
    const unifiedBreakdown = [];

    for (const c of rubric.criteria) {
      const awarded = testGrading.rubric_breakdown[c.name] ?? 0;
      const mult = testGrading.multipliers[c.name] ?? 0.0;
      const reason = testGrading.reasons[c.name] || "Criterion evaluated by Playwright checks.";

      unifiedBreakdown.push({
        item: c.name,
        awarded,
        max: c.weight,
        reason
      });

      if (mult >= 1.0) {
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
      score: testGrading.score,
      rubric_breakdown: testGrading.rubric_breakdown,
      feedback: rubricFeedback,
      rubricFeedback: rubricFeedback,
      warnings: [],
      execution_logs: logs || "",
      status
    };
  }

  // 2. Fallback: AI-based code analysis (identical resilient flow to React, Visual & Backend)
  logger.info(`Test results absent or empty for Job ${jobId}. Falling back to AI code grading.`);

  let repoPath;
  try {
    let codeString = codeContext;
    if (!codeString) {
      repoPath = await cloneRepo(payload.repoUrl || payload.submission_link);
      codeString = await getProjectCodeString(repoPath);
    }

    if (!codeString) {
      logger.warn(`No source files found in student repo for Job ${jobId}`);
      const breakdown = {};
      const unifiedBreakdown = [];
      const issues = ["No source files found in the repository."];
      for (const c of rubric.criteria) {
        breakdown[c.name] = 0;
        unifiedBreakdown.push({
          item: c.name,
          awarded: 0,
          max: c.weight,
          reason: "No source files found."
        });
      }
      const rubricFeedback = {
        summary: "No source files found in the repository.",
        strengths: [],
        issues,
        breakdown: unifiedBreakdown
      };
      return {
        score: 0,
        rubric_breakdown: breakdown,
        feedback: rubricFeedback,
        rubricFeedback: rubricFeedback,
        warnings: ["No source files found in the repository."],
        execution_logs: logs || "",
        status: "fail"
      };
    }

    const openai = getClient();
    if (!openai) {
      logger.error(`OpenAI client unavailable for Fullstack Job ${jobId} and deterministic test results were absent.`);
      throw new Error("AI evaluation service unavailable: OPENAI_API_KEY is missing or invalid on the server.");
    }

    const criteriaList = rubric.criteria
      .map((c, i) => `${i + 1}. "${c.name}" (weight: ${c.weight} points): ${c.description || "No description provided."}`)
      .join("\n");

    const prompt = `You are an expert Full Stack (React, Node/Express, MongoDB/SQL) instructor grading a student's fullstack web application.

## GitHub Actions / Execution Report:
${logs || "No report available."}

## Student's Compressed Source Code:
${codeString}

## Rubric Criteria to Evaluate:
${criteriaList}

## Grading Instructions:
You must be an objective, thorough instructor.
Read the source code carefully across both frontend and backend to determine if the functionality requested in the rubric actually exists.
Check for proper frontend components/state/API calls, backend routes/controllers, database integration, and cross-origin connectivity.
Do NOT penalize if .env file is missing (expected for security reasons).

Assign a score multiplier between 0.0 and 1.0 for EACH criterion:
- 1.0 = Fully meets all exact requirements for this criterion
- 0.7-0.9 = Mostly correct with minor gaps
- 0.4-0.6 = Partial implementation
- 0.1-0.3 = Bare minimum skeleton
- 0.0 = Not attempted, completely missing, or completely unrelated project

For EACH criterion write a concise 1-2 sentence explanation:
1. States specifically what was FOUND in the source code (cite components, routes, or queries).
2. States specifically what is MISSING or WRONG compared to the rubric requirements.

CRITICAL REQUIREMENT:
You MUST evaluate and return a score entry for ALL ${rubric.criteria.length} criteria listed above. Do not stop early. Do not omit any criterion. Keep explanations to 1-2 sentences so all ${rubric.criteria.length} items fit easily.

Output STRICTLY a JSON object (no markdown, no extra text):
{
  "scores": [
    { "name": "<exact criterion name>", "multiplier": <number 0.0-1.0>, "reasoning": "<1-2 sentence concise explanation>" }
  ]
}`;

    logger.info(`Sending code to AI for fullstack rubric scoring (Job: ${jobId})...`);

    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "deepseek-v4-flash",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 3000,
      temperature: 0.1,
      response_format: { type: "json_object" },
    });

    let rawContent = response.choices[0]?.message?.content?.trim() || "";
    logger.info(`AI response received (length: ${rawContent.length}) for Job ${jobId}`);

    // Strip markdown code fences
    if (rawContent.startsWith("```")) {
      rawContent = rawContent.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    }
    // Strip DeepSeek reasoning/think tags
    rawContent = rawContent.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

    let parsed = null;
    try {
      parsed = JSON.parse(rawContent);
    } catch (parseErr) {
      logger.warn(`JSON parse failed: ${parseErr.message}. Attempting regex extraction and repair...`);
      const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          parsed = JSON.parse(jsonMatch[0]);
        } catch {}
      }

      if (!parsed && rawContent.includes('"scores"')) {
        try {
          const lastObjEnd = rawContent.lastIndexOf("}");
          if (lastObjEnd !== -1) {
            const repaired = rawContent.slice(0, lastObjEnd + 1) + "]}";
            parsed = JSON.parse(repaired);
            logger.info("Successfully repaired truncated JSON.");
          }
        } catch {}
      }
    }

    // Normalize scores list from any structure the AI returned
    let rawList = [];
    if (Array.isArray(parsed)) {
      rawList = parsed;
    } else if (Array.isArray(parsed?.scores)) {
      rawList = parsed.scores;
    } else if (Array.isArray(parsed?.rubric_breakdown)) {
      rawList = parsed.rubric_breakdown;
    } else if (Array.isArray(parsed?.criteria)) {
      rawList = parsed.criteria;
    } else if (Array.isArray(parsed?.results)) {
      rawList = parsed.results;
    } else if (typeof parsed === "object" && parsed !== null) {
      rawList = Object.entries(parsed)
        .filter(([key]) => key !== "summary" && key !== "feedback" && key !== "strengths" && key !== "issues")
        .map(([name, val]) => {
          if (typeof val === "object" && val !== null) {
            return { name, ...val };
          }
          return { name, multiplier: typeof val === "number" ? val : 0 };
        });
    }

    const cleanStr = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

    const breakdown = {};
    const reasons = {};
    const multipliers = {};
    let totalScore = 0;

    if (rawList.length > 0) {
      rawList.forEach((scoredCriteria, idx) => {
        if (!scoredCriteria) return;

        // 1. Try fuzzy name matching
        const scoredName = cleanStr(scoredCriteria.name || scoredCriteria.criterion || scoredCriteria.item);
        let matchingRubric = rubric.criteria.find((c) => {
          const rubricName = cleanStr(c.name);
          return (
            rubricName === scoredName ||
            rubricName.includes(scoredName) ||
            scoredName.includes(rubricName)
          );
        });

        // 2. Fallback to index if unmatched
        if (!matchingRubric && rubric.criteria[idx] && breakdown[rubric.criteria[idx].name] === undefined) {
          matchingRubric = rubric.criteria[idx];
        }

        if (matchingRubric && breakdown[matchingRubric.name] === undefined) {
          let rawMult = scoredCriteria.multiplier;
          if (rawMult === undefined) {
            const rawScore = scoredCriteria.score ?? scoredCriteria.awarded ?? scoredCriteria.points ?? scoredCriteria.points_awarded;
            if (typeof rawScore === "number") {
              rawMult = rawScore > 1 ? rawScore / matchingRubric.weight : rawScore;
            }
          }

          const multiplier =
            typeof rawMult === "number"
              ? Math.max(0, Math.min(1, rawMult))
              : 0.5;

          const score = Math.round(matchingRubric.weight * multiplier);
          breakdown[matchingRubric.name] = score;
          reasons[matchingRubric.name] =
            scoredCriteria.reasoning || scoredCriteria.reason || scoredCriteria.comment || scoredCriteria.feedback || "Evaluated by code analysis.";
          multipliers[matchingRubric.name] = multiplier;
          totalScore += score;
        }
      });
    }

    // Check if any criteria were missed by AI and perform targeted retry
    const missingCriteria = rubric.criteria.filter((c) => breakdown[c.name] === undefined);
    if (missingCriteria.length > 0) {
      logger.warn(`AI omitted ${missingCriteria.length} criteria for Fullstack Job ${jobId}. Performing targeted retry...`);
      try {
        const missingList = missingCriteria
          .map((c, i) => `${i + 1}. "${c.name}" (weight: ${c.weight} points): ${c.description || "No description provided."}`)
          .join("\n");
        const retryPrompt = `You are evaluating a student's Fullstack submission. The following criteria need evaluation:

## Student Source Code:
${codeString}

## Rubric Criteria:
${missingList}

Grade each criterion strictly. Return STRICTLY a JSON object:
{
  "scores": [
    { "name": "<exact criterion name>", "multiplier": <number 0.0-1.0>, "reasoning": "<1-2 sentence explanation>" }
  ]
}`;
        const retryResponse = await openai.chat.completions.create({
          model: process.env.OPENAI_MODEL || "deepseek-v4-flash",
          messages: [{ role: "user", content: retryPrompt }],
          max_tokens: 1500,
          temperature: 0.1,
          response_format: { type: "json_object" },
        });
        let retryRaw = retryResponse.choices[0]?.message?.content?.trim() || "";
        if (retryRaw.startsWith("```")) {
          retryRaw = retryRaw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
        }
        retryRaw = retryRaw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
        let retryParsed = null;
        try {
          retryParsed = JSON.parse(retryRaw);
        } catch {
          const m = retryRaw.match(/\{[\s\S]*\}/);
          if (m) try { retryParsed = JSON.parse(m[0]); } catch {}
        }

        const retryList = Array.isArray(retryParsed)
          ? retryParsed
          : retryParsed?.scores || retryParsed?.criteria || [];

        retryList.forEach((scoredCriteria, idx) => {
          if (!scoredCriteria) return;
          const scoredName = cleanStr(scoredCriteria.name || scoredCriteria.criterion);
          let matching = missingCriteria.find((c) => {
            const rName = cleanStr(c.name);
            return rName === scoredName || rName.includes(scoredName) || scoredName.includes(rName);
          }) || missingCriteria[idx];

          if (matching && breakdown[matching.name] === undefined) {
            const rawMult = scoredCriteria.multiplier ?? (typeof scoredCriteria.score === "number" ? scoredCriteria.score / matching.weight : 0.5);
            const multiplier = Math.max(0, Math.min(1, typeof rawMult === "number" ? rawMult : 0.5));
            const score = Math.round(matching.weight * multiplier);
            breakdown[matching.name] = score;
            reasons[matching.name] = scoredCriteria.reasoning || scoredCriteria.reason || "Evaluated by code analysis.";
            multipliers[matching.name] = multiplier;
            totalScore += score;
          }
        });
      } catch (retryErr) {
        logger.warn(`Retry for missing fullstack criteria failed: ${retryErr.message}`);
      }
    }

    // Fill in any remaining missing criteria
    for (const c of rubric.criteria) {
      if (breakdown[c.name] === undefined) {
        breakdown[c.name] = 0;
        reasons[c.name] = "Evaluation completed. Specific criteria breakdown unavailable.";
        multipliers[c.name] = 0.0;
      }
    }

    // Generate concise feedback summary
    const feedbackText = await generateAIFeedback({
      rubric_breakdown: breakdown,
      rubric_criteria: rubric.criteria,
      per_criterion_reasons: reasons,
      score: totalScore,
      warnings: [],
      execution_logs: logs || "",
      assignmentType: "Full Stack (React & Node.js)"
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

      if (mult >= 1.0) {
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
      warnings: [],
      execution_logs: logs || "",
      status: totalScore >= maxScore * 0.5 ? "pass" : "fail"
    };

  } catch (err) {
    logger.error(`AI scoring failed for Fullstack Project (Job: ${jobId}):`, err.message);
    const breakdown = {};
    const unifiedBreakdown = [];
    for (const c of rubric.criteria) {
      breakdown[c.name] = 0;
      unifiedBreakdown.push({
        item: c.name,
        awarded: 0,
        max: c.weight,
        reason: `Grading note: ${err.message}`
      });
    }
    const rubricFeedback = {
      summary: "Evaluation completed with grading notice.",
      strengths: [],
      issues: [err.message],
      breakdown: unifiedBreakdown
    };
    return {
      score: 0,
      rubric_breakdown: breakdown,
      feedback: rubricFeedback,
      rubricFeedback: rubricFeedback,
      warnings: [err.message],
      execution_logs: logs || "",
      status: "fail"
    };
  } finally {
    if (repoPath) {
      await deleteRepo(repoPath);
    }
  }
}
