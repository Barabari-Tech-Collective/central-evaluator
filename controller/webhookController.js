import crypto from 'crypto';
import logger from '../config/logger.js';
import redisConnection from '../config/redis.js';

export const handleGithubWebhook = async (req, res) => {
  try {
    const expected = process.env.WEBHOOK_SECRET;
    if (!expected) {
      logger.error('WEBHOOK_SECRET is not configured on the server — rejecting request (fail closed)');
      return res.status(503).json({ error: 'Webhook server auth not configured' });
    }

    const provided = req.headers['x-webhook-secret'] || '';
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);

    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      logger.warn(`Unauthorized webhook attempt for job ${req.body?.jobId}`);
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { jobId, status } = req.body;

    if (!jobId) {
      return res.status(400).json({ error: "Missing jobId in payload" });
    }

    logger.info(`Received GitHub webhook for job: ${jobId} with status: ${status}`);

    // Publish the entire result to the Redis channel that the worker is listening on
    const publisher = redisConnection.getClient();
    await publisher.publish(
      `github_webhook_${jobId}`,
      JSON.stringify(req.body)
    );

    return res.status(200).json({ success: true, message: "Webhook processed" });
  } catch (error) {
    logger.error(`Error processing GitHub webhook: ${error.message}`);
    return res.status(500).json({ error: "Internal server error" });
  }
};
