import EventEmitter from 'events';
import redisConnection from '../config/redis.js';
import logger from '../config/logger.js';

class WebhookPubSub extends EventEmitter {
  constructor() {
    super();
    this.subscriber = null;
  }

  init() {
    if (this.subscriber) return;
    
    logger.info('Initializing shared Redis subscriber for webhooks...');
    this.subscriber = redisConnection.getClient().duplicate();
    
    // Subscribe to a pattern for all webhooks to avoid 1 connection per job
    this.subscriber.psubscribe('github_webhook_*', (err, count) => {
      if (err) {
        logger.error('Failed to subscribe to github_webhook_* pattern:', err);
      } else {
        logger.info(`Subscribed to github_webhook_* pattern for webhook events`);
      }
    });

    this.subscriber.on('pmessage', (pattern, channel, message) => {
      try {
        logger.info(`WebhookPubSub received pmessage on channel ${channel}`);
        const payload = JSON.parse(message);
        const hasListeners = this.listenerCount(channel) > 0;
        logger.info(`WebhookPubSub emitting to ${channel}. Listeners attached: ${hasListeners}`);
        this.emit(channel, payload);
      } catch (err) {
        logger.error(`Failed to parse webhook message for ${channel}:`, err);
      }
    });
    
    this.subscriber.on('error', (err) => {
      logger.error('Shared webhook subscriber connection error:', err);
    });
  }

  async waitForWebhook(jobId, timeoutMs) {
    this.init(); // ensure subscriber is running

    // Fast path: if the webhook already arrived before we subscribed
    // (e.g. server restarted while GitHub Action was in flight), the
    // webhookController stored it in Redis with a 5-min TTL.
    // Check for it immediately so we don't have to wait for the full timeout.
    const redisClient = redisConnection.getClient();
    const cachedKey = `github_webhook_result_${jobId}`;
    try {
      const cached = await redisClient.get(cachedKey);
      if (cached) {
        logger.info(`WebhookPubSub: found pre-stored webhook result for ${jobId} (cache hit — skipping pub/sub wait)`);
        await redisClient.del(cachedKey); // clean up so re-evaluations don't get stale data
        return JSON.parse(cached);
      }
    } catch (err) {
      logger.warn(`WebhookPubSub: Redis key check failed for ${jobId}: ${err.message} — falling back to pub/sub`);
    }

    return new Promise((resolve, reject) => {
      const channel = `github_webhook_${jobId}`;
      let timeoutId;
      
      logger.info(`WebhookPubSub waitForWebhook setting up listener for ${channel}`);
      
      const handler = (payload) => {
        logger.info(`WebhookPubSub waitForWebhook handler triggered for ${channel}`);
        clearTimeout(timeoutId);
        this.off(channel, handler);
        resolve(payload);
      };

      this.on(channel, handler);

      timeoutId = setTimeout(() => {
        logger.error(`WebhookPubSub waitForWebhook TIMEOUT for ${channel}`);
        this.off(channel, handler);
        reject(new Error("GitHub Actions webhook timeout"));
      }, timeoutMs);
    });
  }
}

export const webhookPubSub = new WebhookPubSub();
