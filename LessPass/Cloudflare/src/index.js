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
    logger.trace('WORKER:ENTRY', 'Worker fetch handler invoked');

    const url = new URL(request.url);
    logger.trace('WORKER:URL_PARSED', `Parsed URL - Host: ${url.host}, Path: ${url.pathname}`);

    const config = initializeConfig(url, env);
    logger.setLogLevel(config.LOG_LEVEL);
    logger.debug('WORKER:LOG_LEVEL_SET', `Log level set to: ${config.LOG_LEVEL}`);

    const upgradeHeader = request.headers.get('Upgrade');
    logger.trace('WORKER:UPGRADE_HEADER', `Upgrade header: ${upgradeHeader}`);

    if (upgradeHeader === 'websocket') {
      logger.info('WORKER:ROUTING', 'Handling WebSocket (VLESS) request.');
      return handleVlessRequest(request, config);
    }
    
    logger.info('WORKER:ROUTING', 'Handling standard HTTP request.');
    return handleHttpRequest(request, config);
  },
};
