// =================================================================
// File: index.js
// Description: Main Cloudflare Worker entry point.
// =================================================================

import { initializeConfig } from './lib/config.js';
import { logger, generateLogId } from './lib/logger.js';
import { handleHttpRequest } from './handler/http.js';
import { handleVlessRequest } from './handler/vless.js';

export default {
  /**
   * Main fetch handler for the Cloudflare Worker.
   * @param {Request} request The incoming request.
   * @param {object} env The environment variables.
   * @returns {Promise<Response>}
   */
  async fetch(request, env) {
    const logId = generateLogId();
    const clientIP = request.headers.get('CF-Connecting-IP') || 'N/A';
    const logContext = { logId, clientIP };

    try {
      const url = new URL(request.url);
      const config = initializeConfig(url, env);
      logger.setLogLevel(config.LOG_LEVEL);

      if (request.headers.get('Upgrade') === 'websocket') {
        logger.info({ ...logContext, section: 'WORKER' }, 'ROUTING', 'Handling WebSocket (VLESS) request.');
        return handleVlessRequest(request, config, logContext);
      } else {
        logger.info({ ...logContext, section: 'WORKER' }, 'ROUTING', 'Handling standard HTTP request.');
        return handleHttpRequest(request, env, config, logContext);
      }
    } catch (err) {
      logger.error({ ...logContext, section: 'WORKER' }, 'FATAL', 'Unhandled top-level error:', err.message);
      return new Response('Internal Server Error', { status: 500 });
    }
  },
};
