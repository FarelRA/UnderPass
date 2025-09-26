// index.js
import { getConfig } from './configs.js';
import { log, generateLogId } from './logs.js';
import { handleConduitRequest } from './conduit.js';
import { handleHttpRequest } from './http.js';

export default {
  /**
   * Cloudflare Worker fetch handler. This is the main entry point for all
   * requests. It determines whether the request is a WebSocket upgrade
   * (for data streaming) or an HTTP request.
   *
   * @param {Request} request - The incoming request.
   * @param {object} env - The environment variables.
   * @returns {Promise<Response>} The response.
   */
  async fetch(request, env) {
    // Generate a unique log ID for this request.
    const logId = generateLogId();
    // Get client IP from Cloudflare headers, default to 'N/A'.
    const clientIP = request.headers.get('CF-Connecting-IP') || 'N/A';
    // Base log context for this request.
    const logContext = { logId, clientIP, section: 'WORKER' };

    try {
      const url = new URL(request.url);
      const config = getConfig(url, env); // Get configuration.
      const upgradeHeader = request.headers.get('Upgrade');

      // Set the log level from config. *MUST* be done before any logging calls.
      log.setLogLevel(config.LOG_LEVEL);

      log.info(logContext, 'REQUEST', 'New request received.');

      if (upgradeHeader === 'websocket') {
        // Handle WebSocket upgrade requests (for data streaming).
        log.info(logContext, 'CONDUIT', 'Handling WebSocket upgrade request.');
        return await handleConduitRequest(request, config, { ...logContext });
      } else {
        // Handle standard HTTP requests.
        log.info(logContext, 'HTTP', 'Handling HTTP request.');
        return await handleHttpRequest(request, env, url, config, { ...logContext });
      }
    } catch (err) {
      log.error(logContext, 'ERROR', 'Fetch error:', err);
      return new Response(err.toString(), { status: 500 });
    }
  },
};
