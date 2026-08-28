import OpenAI from 'openai';
import logger from '../../config/logger.js';
import path from 'path';
import fs from 'fs';
import { cloneRepo, deleteRepo } from '../react/repoService.js';
import { scoreFromTestResults } from './scoringService.js';
import { generateFullstackFeedback } from './feedbackService.js';

let client = null;

function getClient() {
  if (client) return client;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logger.warn('OPENAI_API_KEY not set - Fullstack AI feedback fallback will fail.');
    return null;
  }
  client = new OpenAI({ apiKey });
  return client;
}

/**
 * Recursively reads .js, .jsx, .ts, .tsx, .css, .html files from a directory,
 * ignoring node_modules, dist, build, .git to save tokens.
 */
async function readProjectFiles(dir, fileList = []) {
  const IGNORED_DIRS = new Set(["node_modules", "dist", "build", ".git", ".next", "public", "assets"]);
  const ALLOWED_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".css", ".html"]);

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
      // Skip
    }
  }

  return codeStr;
}

/**
 * Evaluates a Full Stack project.
 * Tries mathematical scoring via Playwright test results first.
 * Falls back to OpenAI AI-based code analysis if test results are absent/failed.
 */
export async function evaluateFullstackProject(payload, jobId, testResults, logs, codeContext = null) {
  const rawCriteria = payload.rubric?.criteria || [];
  const criteria = rawCriteria.map(c => ({
    name: c.name,
    weight: typeof c.weight === 'number' ? c.weight : (typeof c.score === 'number' ? c.score : 0),
    description: c.description || "",
    layer: c.layer || "general"
  }));
  const rubric = { ...payload.rubric, criteria };
  const maxScore = rubric.criteria.reduce((sum, c) => sum + c.weight, 0);

  // Try mathematical scoring if Playwright test results are present
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
      const breakdown = {};
      const unifiedBreakdown = [];
      for (const c of rubric.criteria) {
        breakdown[c.name] = Math.round(c.weight * 0.5);
        unifiedBreakdown.push({
          item: c.name,
          awarded: Math.round(c.weight * 0.5),
          max: c.weight,
          reason: "OpenAI client unavailable. Defaulting to 50% partial credit."
        });
      }
      const rubricFeedback = {
        summary: "AI grading client unavailable. Default partial credit assigned.",
        strengths: [],
        issues: ["OpenAI API key is missing on the server."],
        breakdown: unifiedBreakdown
      };
      return {
        score: Math.round(maxScore * 0.5),
        rubric_breakdown: breakdown,
        feedback: rubricFeedback,
        rubricFeedback: rubricFeedback,
        warnings: ["OpenAI API key missing on server."],
        execution_logs: logs || "",
        status: "fail"
      };
    }

    const rubricText = JSON.stringify(rubric, null, 2);
    const prompt = `
You are an expert Full Stack (MERN/PERN/JAMStack) instructor evaluating a student's assignment.

## Rubric:
${rubricText}

## Student's Core Source Code:
${codeString}

Please carefully analyze the attached source code and determine how well they met the rubric requirements.

Write constructive, encouraging feedback based on their code.
Do NOT mention the numeric score in the feedback text.

Output STRICTLY a JSON object with this exact format (no markdown, no extra text):
{
  "score": <number 0-100>,
  "summary": "1-2 sentences summarizing their attempt.",
  "strengths": ["1 thing they did well, especially regarding architecture"],
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
    logger.error(`AI scoring failed for Fullstack Project (Job: ${jobId}):`, err.message);
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
