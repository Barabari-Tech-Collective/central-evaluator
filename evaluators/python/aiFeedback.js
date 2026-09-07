import OpenAI from "openai";
import logger from "../../config/logger.js";

let client = null;

function getClient() {
  if (client) return client;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logger.warn("OPENAI_API_KEY not set — AI feedback will be skipped.");
    return null;
  }

  client = new OpenAI({
    apiKey,
    baseURL: process.env.OPENAI_BASE_URL || 'https://api.deepseek.com',
  });

  logger.info("OpenAI client initialised for Python Evaluator.");
  return client;
}

/**
 * Attempts to fetch the raw student code from a GitHub URL.
 * If it's a full repo instead of a single file, this might fail, which is okay.
 */
async function fetchStudentCode(repoUrl) {
  if (!repoUrl) return "No repository URL provided.";
  try {
    let rawUrl = repoUrl;
    // Convert github.com blob URLs to raw.githubusercontent.com
    if (repoUrl.includes("github.com") && repoUrl.includes("/blob/")) {
      rawUrl = repoUrl
        .replace("github.com", "raw.githubusercontent.com")
        .replace("/blob/", "/");
    }
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    
    const response = await fetch(rawUrl, { signal: controller.signal });
    clearTimeout(timeoutId);
    
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    
    const data = await response.text();
    // Cap at 2000 chars to save tokens
    return data.slice(0, 2000);
  } catch (err) {
    logger.warn(`Failed to fetch student code for AI feedback: ${err.message}`);
    return "Code could not be automatically fetched.";
  }
}

/**
 * Generates AI-assisted feedback for a student's Python submission.
 *
 * @param {Object} jobData      - The raw BullMQ job data containing testCases, expectedLogs, etc.
 * @param {Object} githubResult - The result returned from the GitHub Action
 * @returns {Promise<string>}   - A single plain-text summary paragraph
 */
export async function generatePythonAIFeedback(jobData, githubResult, finalScore) {
  const openai = getClient();
  const rawFeedback = typeof githubResult?.feedback === 'string' ? githubResult.feedback : JSON.stringify(githubResult);

  // 1. 100% Bypass Logic
  if (finalScore === 100) {
    return "Excellent work! You successfully passed all requirements and test cases without errors.";
  }

  // Fall back to plain string if OpenAI is not configured
  if (!openai) {
    return "Evaluation completed. Some tests failed.";
  }

  // 2. Fetch Context for the AI
  const studentCode = await fetchStudentCode(jobData.submission?.repoUrl);
  
  let requirements = "No specific requirements provided.";
  if (jobData.evaluationMode === "function") {
    requirements = `Function Mode: Expected to write a function named '${jobData.entryFunction}'.\nTest Cases:\n${JSON.stringify(jobData.testCases, null, 2)}`;
  } else {
    requirements = `Script Mode: Expected Console Logs:\n${JSON.stringify(jobData.expectedLogs, null, 2)}`;
  }

  // 3. Build the Prompt
  const prompt = `
You are a Python coding instructor reviewing a student's assignment.

## Assignment Requirements:
${requirements}

## Student's Code (first 2000 chars):
\`\`\`python
${studentCode}
\`\`\`

## Automated Evaluation Result:
Score: ${finalScore}/100
Raw Grader Output: ${rawFeedback}

Write a single, encouraging paragraph (2-3 sentences max) summarizing their attempt and explaining exactly why they failed the test cases (e.g. syntax error, didn't match prints exactly, wrong function output).
Do NOT mention the numeric score.
Do NOT use markdown. Just plain text.
`.trim();

  try {
    logger.info("Sending Python code to OpenAI for feedback generation...");

    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "deepseek-v4-flash",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 150,
      temperature: 0.4,
    });

    const feedbackString = response.choices[0]?.message?.content?.trim();
    logger.info("AI feedback received from OpenAI.");
    
    return feedbackString || "Evaluation completed.";
  } catch (err) {
    logger.error("OpenAI API call failed for Python feedback:", err.message);
    // Fall back gracefully
    return "Evaluation completed. Some test cases failed.";
  }
}
