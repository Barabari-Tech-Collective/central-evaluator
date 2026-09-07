import OpenAI from 'openai';
import Grok from "groq-sdk";
import dotenv from 'dotenv';
import logger from '../../config/logger.js';

dotenv.config();

// V-42: lazy init so a missing GROQ_API_KEY doesn't crash the server at boot.
// Bug (backendBugs.md #5): baseURL was commented out, so this client sent
// GROQ_API_KEY to OpenAI's default endpoint (api.openai.com) instead of
// Groq's — every request failed authentication and fell through to the
// generic fallback string below, silently disabling AI feedback entirely.
let _client;
function getClient() {
  if (!_client) {
    const apiKey = process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY;
    const baseURL = process.env.GROQ_API_KEY
      ? (process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1')
      : (process.env.OPENAI_BASE_URL || 'https://api.deepseek.com');
    if (apiKey) {
      _client = new OpenAI({
        apiKey,
        baseURL,
      });
    }
  }
  return _client;
}

/**
 * Generates smart, encouraging senior developer feedback based on test failures.
 * @param {Array} testResults Detailed test results array
 * @param {Object} rubric The rubric used for evaluation
 * @returns {Promise<string>} AI-generated feedback string
 */
export default async function getAiFeedback(testDetails, rubric) {
  if (!process.env.GROQ_API_KEY && !process.env.OPENAI_API_KEY) {
    return "AI-generated feedback is currently unavailable.";
  }

  // Bug: reported live -- a submission where 0 tests ran at all (e.g. the
  // project's language couldn't be detected, or the test run crashed before
  // producing any results) got this same "Amazing work! ... perfectly."
  // congratulatory message as a genuine 100% pass, since `testDetails` was
  // an empty array either way and `failures.length === 0` is true in both
  // cases. Zero failures only means "everything passed" when there was
  // something to pass in the first place.
  if (testDetails.length === 0) {
    return "No tests could be run for this submission, so there's no pass/fail signal to give feedback on — see the warnings above for why.";
  }

  // Filter for only failed tests to keep the prompt concise
  const failures = testDetails.filter(t => t.status === 'fail');

  if (failures.length === 0) {
    return "Amazing work! Your implementation matches the requirements perfectly. No major technical improvements needed—keep maintaining this standard of excellence!";
  }

  const failureContext = failures.map(f => `
Test Name: ${f.name}
Error: ${f.error?.slice(0, 300) || 'Unknown error'}
  `).join('\n');

  const prompt = `
You are an encouraging Senior Backend Developer performing a code review for a student.
Below are the results of an automated test suite. Some tests failed.

### Failed Tests:
${failureContext}

### Rubric:
${rubric.criteria.map(c => `- ${c.name} (weight: ${c.weight})`).join('\n')}

### Instructions:
1. Provide a brief (max 3-4 sentences) technical advice to the student.
2. Maintain an encouraging but professional "Senior Developer" tone.
3. Be specific about the potential root cause (e.g., missing middleware, bad validation, disk vs DB).
4. Do not just say "check the logs"; give them a hint on *how* to fix it.
5. Do not include any PII or sensitive system data.

Your response:
`;

  try {
    const chatCompletion = await getClient().chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'llama-3.1-8b-instant', // Faster, supported model on Groq
      max_tokens: 300,
      temperature: 0.7,
    });

    return chatCompletion.choices[0].message.content.trim();
  } catch (error) {
    logger.error('Error fetching AI feedback from Groq:', error.message);
    return "We couldn't generate specific AI advice at this moment, but please check the detailed test logs above for clues.";
  }
}