// =================================================================
// File: index.js
// Description: Main Cloudflare Worker entry point.
// =================================================================

import { buildConfig } from './lib/config.js';
import { logger, generateLogId } from './lib/logger.js';
import { handleHttp } from './handler/http.js';
import { handleVless } from './handler/vless.js';

export default {
  /**
   * Main fetch handler for the Cloudflare Worker.
   * Routes requests to either VLESS (WebSocket) or HTTP handlers.
   *
   * @param {Request} request - The incoming HTTP/WebSocket request.
   * @param {object} env - Environment variables from Cloudflare Workers runtime.
   * @returns {Promise<Response>} The response to send back to the client.
   */
  async fetch(request, env) {
    // Initialize request context with unique log ID and client IP
    const logId = generateLogId();
    const clientIP = request.headers.get('CF-Connecting-IP') || 'N/A';
    logger.setLogContext({ logId, clientIP });
    logger.trace('WORKER:INIT', 'Initializing request context');

    // Parse request URL for configuration
    const url = new URL(request.url);
    logger.debug('WORKER:URL', `Request URL: ${url.host}${url.pathname}`);

    // Build configuration from URL params and environment
    const config = buildConfig(url, env);
    logger.setLogLevel(config.LOG_LEVEL);
    logger.debug('WORKER:CONFIG', `Log level set to ${config.LOG_LEVEL}`);

    // Route based on request type (WebSocket vs HTTP)
    if (request.headers.get('Upgrade') === 'websocket') {
      logger.info('WORKER:ROUTE', 'Routing to VLESS WebSocket handler');
      return handleVless(request, config);
    }

    logger.info('WORKER:ROUTE', 'Routing to HTTP handler');
    return handleHttp(request, env, config);
  },
};
