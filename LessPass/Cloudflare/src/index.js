// =================================================================
// File: index.js
// Description: Main Cloudflare Worker entry point.
// =================================================================

import { config, initializeConfig } from './lib/config.js';
import { logger, generateLogId } from './lib/logger.js';
import { handleHttpRequest } from './handler/http.js';
import { handleVlessRequest } from './handler/vless.js';

export default {
  /**
   * Cloudflare Worker fetch handler.
   */
  async fetch(request, env) {
    const logId = generateLogId();
    const clientIP = request.headers.get('CF-Connecting-IP') || 'N/A';
    const logContext = { logId, clientIP, section: 'WORKER' };

    try {
      const url = new URL(request.url);
      initializeConfig(url, env);
      logger.setLogLevel(config.LOG_LEVEL);

      const upgradeHeader = request.headers.get('Upgrade');
      if (upgradeHeader === 'websocket') {
        logger.info(logContext, 'ROUTING', 'Handling WebSocket (VLESS) request.');
        return await handleVlessRequest(request, logContext);
      } else {
        logger.info(logContext, 'ROUTING', 'Handling standard HTTP request.');
        return await handleHttpRequest(request, env, logContext);
      }
    } catch (err) {
      logger.error(logContext, 'FATAL', 'Unhandled top-level error:', err.stack || err);
      return new Response('Internal Server Error', { status: 500 });
    }
  },
};
