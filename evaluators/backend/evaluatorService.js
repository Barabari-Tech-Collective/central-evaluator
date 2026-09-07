import OpenAI from 'openai';
import logger from '../../config/logger.js';
import path from 'path';
import fs from 'fs';
import { cloneRepo, deleteRepo } from '../react/repoService.js';
import { scoreFromTestResults } from './scoringService.js';
import getAiFeedback from './feedbackService.js';

let client = null;

function getClient() {
  if (client) return client;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logger.warn('OPENAI_API_KEY not set - Backend AI feedback will fail.');
    return null;
  }
  client = new OpenAI({ apiKey });
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
 */
async function getProjectCodeString(projectPath) {
  const srcDir = path.join(projectPath, "src");
  let files = [];
  try {
    files = await readProjectFiles(srcDir);
  } catch {
    // No src/ directory
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
 * Evaluates a Backend project.
 * Tries mathematical scoring via Jest test results first.
 * Falls back to OpenAI AI-based code analysis if tests are absent/failed.
 */
export async function evaluateBackendProject(payload, jobId, testResults, logs, codeContext = null) {
  const rawCriteria = payload.rubric?.criteria || [];
  const criteria = rawCriteria.map(c => ({
    name: c.name,
    weight: typeof c.weight === 'number' ? c.weight : (typeof c.score === 'number' ? c.score : 0),
    description: c.description || ""
  }));
  const rubric = { ...payload.rubric, criteria };
  const maxScore = rubric.criteria.reduce((sum, c) => sum + c.weight, 0);

  // Try mathematical scoring if Jest test results are present
  const testGrading = scoreFromTestResults(rubric, testResults);
  if (testGrading) {
    logger.info(`Deterministic testResults found. Grading Backend project mathematically for Job ${jobId}`);

    const status = testGrading.score >= maxScore * 0.5 ? "pass" : "fail";
    const testDetails = testResults.test_details || [];
    
    // Generate technical AI advice paragraph
    const feedbackText = await getAiFeedback(testDetails, rubric);

    // Format output to match react/visual style
    const strengths = [];
    const issues = [];
    const unifiedBreakdown = [];

    for (const c of rubric.criteria) {
      const awarded = testGrading.rubric_breakdown[c.name] ?? 0;
      const mult = testGrading.multipliers[c.name] ?? 0.0;
      const reason = testGrading.reasons[c.name] || "Criterion evaluated by code analysis.";

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
      warnings: testResults.warnings || [],
      execution_logs: logs || "",
      status
    };
  }

  // Fallback: AI-based code analysis
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
      logger.error(`OpenAI client unavailable for Job ${jobId} and deterministic test results were absent.`);
      throw new Error("AI evaluation service unavailable: OPENAI_API_KEY is missing or invalid on the server.");
    }

    const rubricText = JSON.stringify(rubric, null, 2);
    const prompt = `
You are an expert Backend (Node.js/Express/MongoDB) instructor evaluating a student's assignment.

## Rubric:
${rubricText}

## Student's Core Source Code:
${codeString}

Please carefully analyze the attached source code and determine how well they met the rubric requirements.

**IMPORTANT GRADING INSTRUCTIONS:**
1. **Focus on Backend Logic:** Check for proper routing, controller logic, mongoose schemas/models, and error handling.
2. **Missing Files:** The code provided is a subset of the repository. If package.json or minor files are missing, do not heavily penalize them.
3. **Database Connection:** Do not penalize if the .env file is missing, this is expected for security reasons.

Write constructive, encouraging feedback based on their code.
Do NOT mention the numeric score in the feedback text.

Output STRICTLY a JSON object with this exact format (no markdown, no extra text):
{
  "score": <number 0-100>,
  "summary": "1-2 sentences summarizing their attempt.",
  "strengths": ["1 thing they did well, especially regarding backend logic"],
  "issues": ["1-2 things that need fixing based on the rubric"],
  "rubric_breakdown": [
     { "criterion": "Name of criterion", "points_awarded": <number>, "max_points": <number>, "comment": "Brief comment" }
  ]
}
`.trim();

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 500,
      temperature: 0.2,
      response_format: { type: "json_object" },
    });

    const resultStr = response.choices[0].message.content.trim();
    const resultObj = JSON.parse(resultStr);

    const breakdown = {};
    const unifiedBreakdown = [];
    const strengths = resultObj.strengths || [];
    const issues = resultObj.issues || [];

    for (const item of resultObj.rubric_breakdown || []) {
      breakdown[item.criterion] = item.points_awarded;
      unifiedBreakdown.push({
        item: item.criterion,
        awarded: item.points_awarded,
        max: item.max_points,
        reason: item.comment || ""
      });
    }

    // Ensure all criteria are filled
    for (const c of rubric.criteria) {
      if (breakdown[c.name] === undefined) {
        breakdown[c.name] = 0;
        unifiedBreakdown.push({
          item: c.name,
          awarded: 0,
          max: c.weight,
          reason: "Not graded by AI."
        });
      }
    }

    const calculatedScore = Object.values(breakdown).reduce((sum, v) => sum + v, 0);

    const rubricFeedback = {
      summary: resultObj.summary || "Evaluation completed.",
      strengths,
      issues,
      breakdown: unifiedBreakdown
    };

    return {
      score: calculatedScore,
      rubric_breakdown: breakdown,
      feedback: rubricFeedback,
      rubricFeedback: rubricFeedback,
      warnings: [],
      execution_logs: logs || "",
      status: calculatedScore >= maxScore * 0.5 ? "pass" : "fail"
    };

  } catch (err) {
    logger.error(`AI scoring failed for Backend Project (Job: ${jobId}):`, err.message);
    const breakdown = {};
    const unifiedBreakdown = [];
    for (const c of rubric.criteria) {
      breakdown[c.name] = 0;
      unifiedBreakdown.push({
        item: c.name,
        awarded: 0,
        max: c.weight,
        reason: `Grading failed: ${err.message}`
      });
    }
    const rubricFeedback = {
      summary: "Failed to generate AI feedback due to an internal server error.",
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