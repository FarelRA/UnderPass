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
    
    logger.setLogContext({ logId, clientIP });

    const url = new URL(request.url);
    const config = initializeConfig(url, env);
    logger.setLogLevel(config.LOG_LEVEL);

    if (request.headers.get('Upgrade') === 'websocket') {
      logger.info('WORKER:ROUTING', 'WebSocket request');
      return handleVlessRequest(request, config);
    }
    
    logger.info('WORKER:ROUTING', 'HTTP request');
    return handleHttpRequest(request, config);
  },
};
