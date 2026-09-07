import { cloneRepo, deleteRepo } from "../react/repoService.js";
import scoreSubmission from "./scoringService.js";
import logger from "../../config/logger.js";
import fs from "fs";
import path from "path";

/**
 * Evaluates a Visual project (HTML/CSS/JS) using AI-based code analysis.
 *
 * Flow:
 * 1. Clone the student's repository locally
 * 2. Read the source code files
 * 3. Send code + rubric criteria to AI for scoring
 * 4. Generate feedback
 * 5. Clean up cloned repo
 *
 * @param {Object} payload - { repoUrl, rubric }
 * @param {string} jobId   - BullMQ job ID
 * @param {string} githubReport - Syntax check report from GitHub Actions
 * @returns {Promise<Object>} - { score, rubric_breakdown, feedback, status, ... }
 */
export async function evaluateVisualProject(payload, jobId, githubReport) {
  let repoPath = payload.repoUrl;
  let wasCloned = false;
  try {
    logger.info(`Visual evaluation started for job ${jobId}: ${payload.repoUrl}`);

    // If it's a URL, clone it. If it's already a local temp directory (IDE submission), use it directly.
    if (payload.repoUrl && (payload.repoUrl.startsWith('http') || payload.repoUrl.startsWith('git@'))) {
      repoPath = await cloneRepo(payload.repoUrl);
      wasCloned = true;
      logger.info(`Cloned repo to: ${repoPath}`);
    } else {
      logger.info(`Using local directory: ${repoPath}`);
    }

    // AI-based scoring against the rubric
    const finalResult = await scoreSubmission(payload.rubric, repoPath, githubReport);

    logger.info(`Visual evaluation completed for job ${jobId}: score=${finalResult.score}`);

    // Write evaluation log for debugging
    const logsDir = path.join(process.cwd(), "logs");
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

    fs.writeFileSync(path.join(logsDir, "latest_visual_eval.json"), JSON.stringify({
      payload,
      githubReport,
      finalResult
    }, null, 2));

    return finalResult;
  } finally {
    if (wasCloned && repoPath) {
      await deleteRepo(repoPath);
    }
  }
}
