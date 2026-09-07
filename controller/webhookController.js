import logger from '../config/logger.js';
import redisConnection from '../config/redis.js';

export const handleGithubWebhook = async (req, res) => {
  try {
    // BUG (confirmed live, not just by reading the code): if WEBHOOK_SECRET
    // is ever unset — and it will be, on a fresh deploy, because it's not
    // in .env.example the way API_KEY is — process.env.WEBHOOK_SECRET is
    // `undefined`. An attacker who simply omits the x-webhook-secret header
    // gets `secret === undefined` too, so `undefined !== undefined` is
    // `false` and this check PASSES with no secret at all. Reproduced:
    // curl -X POST /api/webhook/github -d '{"jobId":"999","status":"completed","testResults":{...fake...}}'
    // with no header returned 200 and published the forged result to Redis
    // as if GitHub Actions had sent it. Since this is the only auth on the
    // route (see server.js — no requireApiKey/rate limiter here), anyone
    // who can reach this endpoint can inject a fake "all tests passed"
    // result for any jobId once this happens.
    //
    // FIX (three changes, all needed):
    //   1. Fail closed, the same way middleware/auth.js's requireApiKey
    //      does for API_KEY: if `!process.env.WEBHOOK_SECRET`, log loudly
    //      and return 500/503 immediately, before comparing anything.
    //   2. Use crypto.timingSafeEqual (already imported in
    //      middleware/auth.js — reuse that exact pattern) instead of `!==`,
    //      so a correctly-configured secret isn't leaked via timing either.
    //   3. Add WEBHOOK_SECRET to .env.example so nobody deploys without it.
    const secret = req.headers['x-webhook-secret'];
    if (secret !== process.env.WEBHOOK_SECRET) {
      logger.warn(`Unauthorized webhook attempt for job ${req.body?.jobId}`);
      return res.status(401).json({ error: "Unauthorized" });
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
