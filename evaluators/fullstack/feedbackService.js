import OpenAI from "openai";
import dotenv from "dotenv";
import logger from "../../config/logger.js";

dotenv.config();

let client = null;

function getOpenAIClient() {
  if (client) return client;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logger.warn("[FullstackFeedback] OPENAI_API_KEY is not set.");
    return null;
  }
  client = new OpenAI({
    apiKey,
    baseURL: process.env.OPENAI_BASE_URL || 'https://api.deepseek.com',
  });
  return client;
}

/**
 * Generates structured, educational AI feedback for a fullstack submission using OpenAI gpt-4o-mini.
 *
 * @param {Array|Object} backendResultsOrTestDetails - Playwright test details or backend results
 * @param {Object} frontendResultsOrRubric - Frontend results or Rubric object
 * @param {Object} [rubric] - Optional Rubric object
 * @returns {Promise<string>}
 */
export async function generateFullstackFeedback(backendResultsOrTestDetails, frontendResultsOrRubric, rubric) {
  const openai = getOpenAIClient();

  let failureContext = "";
  let rubricCriteria = [];

  if (Array.isArray(backendResultsOrTestDetails)) {
    // Unified testDetails format
    const testDetails = backendResultsOrTestDetails;
    const failures = testDetails.filter((t) => t.status === "fail");
    if (failures.length === 0) {
      return "Excellent work! Both your backend API and frontend UI passed all tests. Your fullstack implementation is solid — keep it up!";
    }
    failureContext = failures
      .map((f) => `Test: ${f.name}\n  Error: ${f.error?.slice(0, 300) ?? "Unknown error"}`)
      .join("\n\n");
    rubricCriteria = frontendResultsOrRubric?.criteria || rubric?.criteria || [];
  } else {
    // Separate backend/frontend results format
    const backendResults = backendResultsOrTestDetails || { test_details: [] };
    const frontendResultsObj = frontendResultsOrRubric || { test_details: [] };
    const backendFailures = (backendResults.test_details || []).filter((t) => t.status === "fail");
    const frontendFailures = (frontendResultsObj.test_details || []).filter((t) => t.status === "fail");

    if (backendFailures.length === 0 && frontendFailures.length === 0) {
      return "Excellent work! Both your backend API and frontend UI passed all tests. Your fullstack implementation is solid — keep it up!";
    }

    const formatFailures = (failures, layer) =>
      failures
        .map((f) => `[${layer}] Test: ${f.name}\n  Error: ${f.error?.slice(0, 300) ?? "Unknown error"}`)
        .join("\n");

    failureContext = [
      backendFailures.length ? formatFailures(backendFailures, "Backend") : "",
      frontendFailures.length ? formatFailures(frontendFailures, "Frontend") : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    rubricCriteria = rubric?.criteria || frontendResultsOrRubric?.criteria || [];
  }

  if (!openai) {
    return buildFallbackFeedback(failureContext, rubricCriteria);
  }

  const prompt = `
You are a senior fullstack engineering instructor writing an overall constructive review for a student's graded fullstack web assignment (React + Node/Express).

### Automated Test Failures:
${failureContext}

### Rubric Breakdown:
${rubricCriteria.map((c) => `- [${c.layer ?? "general"}] ${c.name} (weight: ${c.weight})`).join("\n")}

### Instructions:
1. Write 3-4 concise, helpful sentences summarizing the key technical issues.
2. Address both Backend and Frontend issues directly (e.g. mention if API routes failed, or if frontend connection refused/timed out).
3. Provide one concrete, actionable suggestion to fix the root cause.
4. Do NOT mention exact point numbers or score values.
5. Tone: encouraging, professional, and clear.
`.trim();

  try {
    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "deepseek-v4-flash",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 350,
      temperature: 0.4,
    });

    const feedback = response.choices[0]?.message?.content?.trim();
    return feedback || buildFallbackFeedback(failureContext, rubricCriteria);
  } catch (err) {
    logger.error("[FullstackFeedback] OpenAI API error:", err.message);
    return buildFallbackFeedback(failureContext, rubricCriteria);
  }
}

/**
 * Rule-based fallback feedback if OpenAI is offline.
 */
function buildFallbackFeedback(failureContext, rubricCriteria) {
  if (!failureContext) {
    return "Great work! All fullstack requirements and test cases passed successfully.";
  }
  return "Your fullstack project encountered errors during automated testing. Please review the specific test failures above to verify your backend API routes, frontend server startup, and cross-origin connectivity.";
}
