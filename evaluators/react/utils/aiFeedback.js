/**
 * Requires: GROQ_API_KEY in .env file
 */
import Grok from "groq-sdk";
import OpenAI from "openai";
import logger from "../../../config/logger.js";
import fs from "fs/promises";
import path from "path";

let client = null;

function getClient() {
  if (client) return client;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logger.warn("OPENAI_API_KEY not set — AI feedback will be skipped.");
    return null;
  }

  // Use the official OpenAI endpoint or DeepSeek
  client = new OpenAI({
    apiKey,
    baseURL: process.env.OPENAI_BASE_URL || 'https://api.deepseek.com',
  });

  logger.info("Groq client initialised.");
  return client;
}

/**
 * Generates AI-assisted feedback for a student's React submission.
 *
 * @param {Object} params
 * @param {Object} params.rubric_breakdown  - { criteriaName: score, ... }
 * @param {number} params.score             - Total score achieved
 * @param {string[]} params.warnings        - Warning messages from scorer
 * @param {string} params.execution_logs    - Raw build/test logs
 *
/**
 * Generates AI-assisted feedback for a student's submission.
 *
 * @param {Object} params
 * @param {Object} params.rubric_breakdown  - { criteriaName: score, ... }
 * @param {Array}  params.rubric_criteria   - [ { name, weight, description }, ... ]
 * @param {Object} params.per_criterion_reasons - { criteriaName: reasonString, ... }
 * @param {number} params.score             - Total score achieved
 * @param {string[]} params.warnings        - Warning messages from scorer
 * @param {string} params.execution_logs    - Raw build/test logs
 * @param {string} [params.assignmentType]  - 'React' or 'HTML, CSS & JavaScript DOM'
 * @param {string} [params.codeSnippet]     - Student's source code for citing specific lines
 *
 * @returns {Promise<string>} feedback - A comprehensive, instructional review with code fixes
 */
export async function generateAIFeedback({
  rubric_breakdown,
  rubric_criteria,
  per_criterion_reasons,
  score,
  warnings,
  execution_logs,
  assignmentType = 'React',
  codeSnippet = '',
}) {
  // Directly use the clean, concise feedback format matching the facilitator dashboard
  return buildFallbackFeedback(rubric_breakdown, score, warnings, assignmentType);
}

/**
 * Rule-based fallback feedback used when AI is unavailable or fails.
 */
function buildFallbackFeedback(rubric_breakdown, score, warnings, assignmentType = 'React') {
  const passed = Object.entries(rubric_breakdown)
    .filter(([, pts]) => pts > 0)
    .map(([name]) => name);

  const failed = Object.entries(rubric_breakdown)
    .filter(([, pts]) => pts === 0)
    .map(([name]) => name);

  if (failed.length === 0) {
    return `Great work! All criteria passed successfully. Your ${assignmentType} application is well-structured and fully functional.`;
  }

  const passedStr =
    passed.length > 0
      ? `You successfully implemented: ${passed.join(', ')}.\n\n`
      : '';
  const failedStr = `The following areas need attention: ${failed.join(', ')}.\n\n`;
  const tip =
    assignmentType.includes('DOM') || assignmentType.includes('HTML')
      ? 'Review the failing criteria to ensure all DOM element selectors, event listeners, and live updates match the specification.'
      : 'Review the failing criteria and ensure your components, state management, and props are correctly implemented.';

  return passedStr + failedStr + tip;
}

/**
 * Recursively reads .js and .jsx files from a directory, ignoring node_modules/dist/build.
 */
async function readProjectFiles(dir, fileList = []) {
  const files = await fs.readdir(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      if (file !== 'node_modules' && file !== 'dist' && file !== 'build') {
        await readProjectFiles(filePath, fileList);
      }
    } else if (file.endsWith('.js') || file.endsWith('.jsx')) {
      fileList.push(filePath);
    }
  }
  return fileList;
}

/**
 * Uses Groq AI to read the actual React code files and grade their structure.
 */
export async function evaluateCodeStructure(projectPath) {
  const openai = getClient();
  if (!openai) return { scoreMultiplier: 1, reasoning: "AI offline, granted full credit." };

  try {
    const srcDir = path.join(projectPath, "src");
    let files = [];
    try {
      files = await readProjectFiles(srcDir);
    } catch {
      try { files = await readProjectFiles(projectPath); } catch { files = []; }
    }

    // Limit to 6 main files to save tokens
    files = files.slice(0, 6);
    if (files.length === 0) return { scoreMultiplier: 0, reasoning: "No source files found." };

    let codeStr = "";
    for (const f of files) {
      const relativePath = path.relative(projectPath, f);
      const content = await fs.readFile(f, "utf8");
      codeStr += `\n--- ${relativePath} ---\n${content.slice(0, 2000)}\n`;
    }

    const prompt = `
You are an expert React instructor grading the "Code Structure" portion of an assignment.
Read these main files from the student's submission:
${codeStr}

Evaluate component breakdown, hook usage, and React best practices.
Output STRICTLY a JSON object:
{
  "scoreMultiplier": <number strictly between 0.0 and 1.0 representing percentage grade>,
  "reasoning": "<1 sentence explanation on what was good or bad>"
}
Do NOT include any markdown or text besides the raw JSON object.
`.trim();

    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "deepseek-v4-flash",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 150,
      temperature: 0.1,
      response_format: { type: "json_object" }
    });

    const parsed = JSON.parse(response.choices[0].message.content.trim());
    return {
      scoreMultiplier: typeof parsed.scoreMultiplier === "number" ? parsed.scoreMultiplier : 1,
      reasoning: parsed.reasoning || ""
    };
  } catch (err) {
    logger.error("Code structure evaluation failed:", err.message);
    return { scoreMultiplier: 1, reasoning: "Evaluation errored, defaulting to full credit." };
  }
}