import { cloneRepo, deleteRepo } from "./repoService.js";
import scoreSubmission from "./scoringService.js";
import logger from "../../config/logger.js";
import fs from "fs";
import path from "path";

/**
 * Evaluates a React project using pure AI-based code analysis.
 *
 * Flow:
 * 1. Clone the student's repository locally
 * 2. Read the source code files
 * 3. Send code + rubric criteria to Groq AI for scoring
 * 4. Generate feedback
 * 5. Clean up cloned repo
 *
 * @param {Object} payload - { repoUrl, rubric, submissionId, ... }
 * @param {string} jobId   - BullMQ job ID
 * @param {string} githubReport - Build/Linter report from GitHub Actions
 * @param {string} testResults - Test suite results
 * @returns {Promise<Object>} - { score, rubric_breakdown, feedback, status, ... }
 */
export async function evaluateReactProject(payload, jobId, githubReport, testResults) {
  let repoPath;
  try {
    logger.info(`React evaluation started for job ${jobId}: ${payload.repoUrl}`);

    // Step 1: Clone the student's repo locally (so we can compress the source code for the AI)
    repoPath = await cloneRepo(payload.repoUrl);
    logger.info(`Cloned repo to: ${repoPath}`);

    // Step 2: AI-based scoring against the rubric, using the compressed code + github report
    const finalResult = await scoreSubmission(payload.rubric, repoPath, githubReport, testResults);

    logger.info(`React evaluation completed for job ${jobId}: score=${finalResult.score}`);

    // Step 3: Write evaluation log for debugging
    const logsDir = path.join(process.cwd(), "logs");
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

    fs.writeFileSync(path.join(logsDir, "latest_eval.json"), JSON.stringify({
      payload,
      githubReport,
      finalResult
    }, null, 2));

    return finalResult;
  } finally {
    if (repoPath) {
      await deleteRepo(repoPath);
    }
  }
}
