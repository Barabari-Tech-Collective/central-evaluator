import queueManager from '../config/queueManager.js';
import logger from '../config/logger.js';
import { ValidationError } from '../controller/evaluatorController.js';

export async function routeEvaluation(payload) {
  const { type } = payload;

  // Validate type
  if (!queueManager.getQueueTypes().includes(type)) {
    throw new ValidationError(`Invalid evaluator type: ${type}`);
  }

  try {
    // Add job to appropriate queue
    // const job = await queueManager.addEvaluation(type, payload);
    // logger.info(`Job routed: ${type}`, { jobId: job.id });
    // return job;
    if (
  ['javascript', 'visual', 'python'].includes(type) &&
  payload.submissions
) {

  const jobs = [];

  for (const submission of payload.submissions) {

    const job =
      await queueManager.addEvaluation(
        type,
      {
        submission,
        testCases:
          payload.testCases,
        entryFunction:
          payload.entryFunction,
        functions:
          payload.functions,
        evaluationMode:
          payload.evaluationMode,
        expectedLogs:
         payload.expectedLogs,
        assignmentId:
         payload.assignmentId,
        rubricText:
          payload.rubricText,
        expectedUrl:
          payload.expectedUrl
      }
      );

    jobs.push(job);
  }

  return jobs;
}

const job =
  await queueManager.addEvaluation(
    type,
    payload
  );

return job;

  } catch (err) {
    logger.error(`Failed to route evaluation:`, err);
    throw err;
  }
}