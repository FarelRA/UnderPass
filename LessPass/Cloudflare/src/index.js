// index.js
import { getConfig } from './configs.js';
import { log, generateLogId } from './logs.js';
import { handleConduitRequest } from './conduit.js';
import { handleHttpRequest } from './http.js';

export default {
  /**
   * Cloudflare Worker fetch handler. This is the main entry point for all
   * requests. It determines whether the request is a WebSocket upgrade
   * (for VLESS data streaming) or a standard HTTP request.
   *
   * @param {Request} request - The incoming request from the client.
   * @param {object} env - The environment variables configured in the Cloudflare dashboard.
   * @returns {Promise<Response>} The response to be sent back to the client.
   */
  async fetch(request, env) {
    const logId = generateLogId();
    const clientIP = request.headers.get('CF-Connecting-IP') || 'N/A';
    const logContext = { logId, clientIP, section: 'WORKER' };
    try {
      const url = new URL(request.url);
      const config = getConfig(url, env);
      const upgradeHeader = request.headers.get('Upgrade');
      log.setLogLevel(config.LOG_LEVEL);
      log.info(logContext, 'REQUEST', 'New request received.');
      if (upgradeHeader === 'websocket') {
        log.info(logContext, 'CONDUIT', 'Handling WebSocket upgrade request.');
        return await handleConduitRequest(request, config, { ...logContext });
      } else {
        log.info(logContext, 'HTTP', 'Handling HTTP request.');
        return await handleHttpRequest(request, env, url, config, { ...logContext });
      }
    } catch (err) {
      log.error(logContext, 'ERROR', 'Top-level fetch error:', err.stack || err);
      // Use a standard Response object for errors
      return new Response(err.toString(), { status: 500 });
    }
  },
};
