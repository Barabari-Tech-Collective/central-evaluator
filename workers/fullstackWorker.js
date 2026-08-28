import { Worker } from 'bullmq';
import redisConnection from '../config/redis.js';
import queueManager from '../config/queueManager.js';
import logger from '../config/logger.js';
import { triggerGraderWorkflow } from '../services/githubActionService.js';
import { withTimeout } from '../evaluators/react/utils/timeout.js';
import { evaluateFullstackProject } from "../evaluators/fullstack/evaluatorService.js";
import { webhookPubSub } from '../services/webhookPubSub.js';

let fullstackWorker = null;

export async function initializeFullstackWorker() {
  try {
    logger.info('Initializing Fullstack Worker...');

    const config = queueManager.getConfig('fullstack');

    fullstackWorker = new Worker(
      'fullstack-evaluation',
      async (job) => {
        try {
          logger.info(`Starting Fullstack evaluation: ${job.id}`);
          
          // Phase 1: Dispatch to GitHub Actions
          const githubResult = await withTimeout(
            (async () => {
              const webhookPromise = webhookPubSub.waitForWebhook(job.id, config.timeout);
              
              const webhookUrl = `${process.env.BASE_URL}/api/webhook/github`;
              const repoUrl = job.data.repoUrl || job.data.submission_link;
              const specFile = job.data.rubric?.specFile || null;
              await triggerGraderWorkflow(repoUrl, job.id, webhookUrl, 'run-fullstack-evaluation', {
                rubric: job.data.rubric,
                specFile
              });
              
              return await webhookPromise;
            })(),
            config.timeout,
            `fullstack-eval-github ${job.id}`
          );

          // Phase 2: Handle GitHub result
          const buildFailed = githubResult.status !== 'completed' || !githubResult.testResults;
          if (buildFailed) {
            logger.info(`Fullstack Job ${job.id} had run failure on GitHub Actions. Still running AI rubric scoring for partial credit.`);
          } else {
            logger.info(`GitHub Action completed successfully for Fullstack Job ${job.id}. Proceeding to rubric evaluation.`);
          }

          // Phase 3: Evaluate with Playwright test results or fallback to AI scoring
          const githubReport = githubResult.testOutput || (buildFailed ? 'Run: Failed. The test execution encountered an error.' : 'Run Completed.');
          logger.info(`RAW PLAYWRIGHT RESULTS FOR JOB ${job.id}: ${JSON.stringify(githubResult.testResults)}`);
          const results = await evaluateFullstackProject(job.data, job.id, githubResult.testResults, githubReport);
          
          logger.info(`Fullstack Job ${job.id} completed entirely.`);
          return { success: true, results };
        } catch (err) {
          logger.error(`Fullstack Job ${job.id} failed`, err);
          throw err;
        }
      },
      {
        connection: redisConnection.getClient(),
        concurrency: config.concurrency,
        settings: {
          maxStalledCount: 2,
          lockDuration: 30000,
          lockRenewTime: 15000
        }
      }
    );

    // Event handlers
    fullstackWorker.on('completed', (job, result) => {
      logger.info(`Fullstack Job ${job.id} completed`, {
        duration: job.finishedOn - job.processedOn
      });
    });

    fullstackWorker.on('failed', (job, err) => {
      logger.error(`FullStack Job ${job.id} failed`, {
        error: err.message,
        attempts: job.attemptsMade
      });
    });

    logger.info('Fullstack Worker initialized');
    return fullstackWorker;

  } catch (err) {
    logger.error('Failed to initialize Fullstack worker:', err);
    throw err;
  }
}

export async function stopFullstackWorker() {
  try {
    if (fullstackWorker) {
      await fullstackWorker.close();
    }
    logger.info('Fullstack worker stopped');
  } catch (err) {
    logger.error('Error stopping Fullstack worker:', err);
  }
}

export function getFullstackWorkerStatus() {
  return {
    status: fullstackWorker ? 'running' : 'not_initialized',
    concurrency: queueManager.getConfig('fullstack').concurrency
  };
}

export { fullstackWorker };