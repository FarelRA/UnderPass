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
   * Routes requests to either VLESS (WebSocket) or HTTP handlers based on the Upgrade header.
   * 
   * @param {Request} request - The incoming HTTP/WebSocket request.
   * @param {object} env - Environment variables from Cloudflare Workers runtime.
   * @returns {Promise<Response>} The response to send back to the client.
   */
  async fetch(request, env) {
    // === Initialize Request Context ===
    const logId = generateLogId();
    const clientIP = request.headers.get('CF-Connecting-IP') || 'N/A';
    
    logger.setLogContext({ logId, clientIP });
    logger.trace('WORKER:ENTRY', 'Worker fetch handler invoked');

    // === Parse Request URL ===
    const url = new URL(request.url);
    logger.trace('WORKER:URL_PARSED', `Parsed URL - Host: ${url.host}, Path: ${url.pathname}`);

    // === Initialize Configuration ===
    const config = initializeConfig(url, env);
    logger.setLogLevel(config.LOG_LEVEL);
    logger.debug('WORKER:LOG_LEVEL_SET', `Log level set to: ${config.LOG_LEVEL}`);

    // === Route Based on Request Type ===
    const upgradeHeader = request.headers.get('Upgrade');
    logger.trace('WORKER:UPGRADE_HEADER', `Upgrade header: ${upgradeHeader}`);

    const isWebSocketRequest = upgradeHeader === 'websocket';
    
    if (isWebSocketRequest) {
      logger.info('WORKER:ROUTING', 'Handling WebSocket (VLESS) request.');
      return handleVlessRequest(request, config);
    }
    
    logger.info('WORKER:ROUTING', 'Handling standard HTTP request.');
    return handleHttpRequest(request, config);
  },
};
