import { Worker } from 'bullmq';
import redisConnection from '../config/redis.js';
import queueManager from '../config/queueManager.js';
import logger from '../config/logger.js';
import { triggerGraderWorkflow } from '../services/githubActionService.js';
import { withTimeout } from '../evaluators/react/utils/timeout.js';
import { evaluateReactProject } from '../evaluators/react/evaluatorService.js';
import { webhookPubSub } from '../services/webhookPubSub.js';

let reactWorker = null;

export async function initializeReactWorker() {
  try {
    logger.info('Initializing React Worker...');

    const config = queueManager.getConfig('react');

    reactWorker = new Worker(
      'react-evaluation',
      async (job) => {
        try {
          logger.info(`Starting React evaluation: ${job.id}`);
          
          const results = await withTimeout(
            (async () => {
              if (job.data.ideFiles) {
                logger.info(`React Job ${job.id} is an IDE submission. Skipping GitHub Actions.`);
                const githubReport = "IDE Submission - Build and Linter assume passed.\n\n" + job.data.ideFiles.map(f => `--- ${f.name} ---\n${f.content}`).join('\n\n');
                return await evaluateReactProject(job.data, job.id, githubReport);
              }

              // Phase 1: Wait for webhook & Dispatch to GitHub Actions
              const webhookPromise = webhookPubSub.waitForWebhook(job.id, config.timeout);
              
              const webhookUrl = `${process.env.BASE_URL}/api/webhook/github`;
              const repoUrl = job.data.repoUrl || job.data.submission_link;
              await triggerGraderWorkflow(repoUrl, job.id, webhookUrl, 'run-react-evaluation');
              
              // Now await the result
              const githubResult = await webhookPromise;

              // Phase 2: Handle GitHub result
              const buildFailed = githubResult.status !== 'completed' ||
                (githubResult.testOutput || '').toLowerCase().includes('build: failed') ||
                (githubResult.testOutput || '').toLowerCase().includes('failed to compile');

              if (buildFailed) {
                logger.info(`React Job ${job.id} had build failure on GitHub Actions. Still running AI rubric scoring for partial credit.`);
              } else {
                logger.info(`GitHub Action completed successfully for React Job ${job.id}. Proceeding to AI rubric evaluation.`);
              }

              // Phase 3: Always run AI rubric scoring (build report is passed as context)
              // Build failures penalise relevant criteria (UI/CSS), but students still
              // get credit for state management, function logic, etc that can be
              // assessed from the source code alone.
              const githubReport = githubResult.testOutput || (buildFailed ? 'Build: Failed. The application could not be compiled.' : 'Build and Linter Passed.');
              return await evaluateReactProject(job.data, job.id, githubReport, githubResult.testResults);
            })(),
            config.timeout,
            `react-eval-job ${job.id}`
          );
          
          logger.info(`React Job ${job.id} completed entirely.`);
          return { success: true, results };
        } catch (err) {
          logger.error(`React Job ${job.id} failed`, err);
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
    reactWorker.on('completed', (job, result) => {
      logger.info(`React Job ${job.id} completed`, {
        duration: job.finishedOn - job.processedOn
      });
    });

    reactWorker.on('failed', (job, err) => {
      logger.error(`React Job ${job.id} failed`, {
        error: err.message,
        attempts: job.attemptsMade
      });
    });

    logger.info('React Worker initialized');
    return reactWorker;

  } catch (err) {
    logger.error('Failed to initialize React worker:', err);
    throw err;
  }
}

export async function stopReactWorker() {
  try {
    if (reactWorker) {
      await reactWorker.close();
    }
    logger.info('React worker stopped');
  } catch (err) {
    logger.error('Error stopping React worker:', err);
  }
}

export function getJsWorkerStatus() {
  return {
    status: reactWorker ? 'running' : 'not_initialized',
    concurrency: queueManager.getConfig('react').concurrency
  };
}

export { reactWorker };