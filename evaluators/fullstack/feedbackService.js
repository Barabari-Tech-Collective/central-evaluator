import OpenAI from "openai";
import grok from "groq-sdk";
import dotenv from "dotenv";

dotenv.config();

// V-42: lazy init so a missing GROQ_API_KEY doesn't crash the server at boot.
let _client;
function getClient() {
  if (!_client) {
    _client = new OpenAI({
      apiKey: process.env.GROQ_API_KEY,
      baseURL: process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1",
    });
  }
  return _client;
}

export async function generateFullstackFeedback(backendResultsOrTestDetails, frontendResults, rubric) {
  if (!process.env.GROQ_API_KEY) {
    return "AI-generated feedback is currently unavailable.";
  }

  let failureContext = "";
  let rubricCriteria = [];

  if (Array.isArray(backendResultsOrTestDetails)) {
    // New unified testDetails format
    const testDetails = backendResultsOrTestDetails;
    const failures = testDetails.filter((t) => t.status === "fail");
    if (failures.length === 0) {
      return "Excellent work! Both your backend API and frontend UI passed all tests. Your fullstack implementation is solid — keep it up!";
    }
    failureContext = failures
      .map((f) => `Test: ${f.name}\n  Error: ${f.error?.slice(0, 250) ?? "Unknown error"}`)
      .join("\n\n");
    rubricCriteria = frontendResults?.criteria || []; // the 2nd arg behaves as rubric
  } else {
    // Old format
    const backendResults = backendResultsOrTestDetails || { test_details: [] };
    const frontendResultsObj = frontendResults || { test_details: [] };
    const backendFailures = (backendResults.test_details || []).filter((t) => t.status === "fail");
    const frontendFailures = (frontendResultsObj.test_details || []).filter((t) => t.status === "fail");

    if (backendFailures.length === 0 && frontendFailures.length === 0) {
      return "Excellent work! Both your backend API and frontend UI passed all tests. Your fullstack implementation is solid — keep it up!";
    }

    const formatFailures = (failures, layer) =>
      failures
        .map((f) => `[${layer}] Test: ${f.name}\n  Error: ${f.error?.slice(0, 250) ?? "Unknown error"}`)
        .join("\n");

    failureContext = [
      backendFailures.length ? formatFailures(backendFailures, "Backend") : "",
      frontendFailures.length ? formatFailures(frontendFailures, "Frontend") : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    rubricCriteria = rubric?.criteria || [];
  }

  const prompt = `
You are an encouraging Senior Fullstack Developer performing a code review for a student.
Below are the failed tests from an automated evaluation of their fullstack project.

### Failed Tests:
${failureContext}

### Rubric:
${rubricCriteria.map((c) => `- [${c.layer ?? "general"}] ${c.name} (weight: ${c.weight})`).join("\n")}

### Instructions:
1. Give brief (3-5 sentences) technical advice covering both backend and frontend issues.
2. Be specific about root causes — don't just say "check logs".
3. Maintain an encouraging, senior developer tone.
4. Do not include PII or sensitive system data.

Your response:
`;

  try {
    const completion = await getClient().chat.completions.create({
      messages: [{ role: "user", content: prompt }],
      model: "llama-3.1-8b-instant",
      max_tokens: 400,
      temperature: 0.7,
    });

    return completion.choices[0].message.content.trim();
  } catch (err) {
    console.error("[FullstackFeedback] Groq error:", err.message);
    return "AI feedback is temporarily unavailable. Please review the test details above for hints.";
  }
}
