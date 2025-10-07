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
      if (!request || !request.url) {
        logger.error({ ...logContext, section: 'WORKER' }, 'INVALID_REQUEST', 'Request or request.url is null/undefined');
        return new Response('Bad Request', { status: 400 });
      }

      let url;
      try {
        url = new URL(request.url);
      } catch (urlError) {
        logger.error({ ...logContext, section: 'WORKER' }, 'URL_PARSE_ERROR', `Failed to parse URL: ${urlError.message}`);
        return new Response('Bad Request: Invalid URL', { status: 400 });
      }

      let config;
      try {
        config = initializeConfig(url, env);
      } catch (configError) {
        logger.error({ ...logContext, section: 'WORKER' }, 'CONFIG_ERROR', `Failed to initialize config: ${configError.message}`);
        return new Response('Internal Server Error: Configuration failed', { status: 500 });
      }

      try {
        logger.setLogLevel(config.LOG_LEVEL);
      } catch (logError) {
        logger.error({ ...logContext, section: 'WORKER' }, 'LOG_LEVEL_ERROR', `Failed to set log level: ${logError.message}`);
      }

      const upgradeHeader = request.headers.get('Upgrade');
      if (upgradeHeader === 'websocket') {
        logger.info({ ...logContext, section: 'WORKER' }, 'ROUTING', 'Handling WebSocket (VLESS) request.');
        try {
          return handleVlessRequest(request, config, logContext);
        } catch (vlessError) {
          logger.error({ ...logContext, section: 'WORKER' }, 'VLESS_HANDLER_ERROR', `VLESS handler failed: ${vlessError.message}`);
          return new Response('WebSocket Upgrade Failed', { status: 500 });
        }
      } else {
        logger.info({ ...logContext, section: 'WORKER' }, 'ROUTING', 'Handling standard HTTP request.');
        try {
          return handleHttpRequest(request, env, config, logContext);
        } catch (httpError) {
          logger.error({ ...logContext, section: 'WORKER' }, 'HTTP_HANDLER_ERROR', `HTTP handler failed: ${httpError.message}`);
          return new Response('Internal Server Error', { status: 500 });
        }
      }
    } catch (err) {
      logger.error({ ...logContext, section: 'WORKER' }, 'FATAL', `Unhandled top-level error: ${err.message}`, err.stack);
      return new Response('Internal Server Error', { status: 500 });
    }
  },
};
