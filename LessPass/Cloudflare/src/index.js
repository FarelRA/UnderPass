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

    try {
      if (!request || !request.url) {
        logger.error('WORKER:INVALID_REQUEST', 'Request or request.url is null/undefined');
        return new Response('Bad Request', { status: 400 });
      }

      logger.debug('WORKER:REQUEST_VALID', `Request URL: ${request.url}, Method: ${request.method}`);

      let url;
      try {
        url = new URL(request.url);
        logger.trace('WORKER:URL_PARSED', `Parsed URL - Host: ${url.host}, Path: ${url.pathname}`);
      } catch (urlError) {
        logger.error('WORKER:URL_PARSE_ERROR', `Failed to parse URL: ${urlError.message}`);
        return new Response('Bad Request: Invalid URL', { status: 400 });
      }

      let config;
      try {
        logger.debug('WORKER:CONFIG_INIT', 'Initializing configuration');
        config = initializeConfig(url, env);
        logger.trace('WORKER:CONFIG_LOADED', `Config: LOG_LEVEL=${config.LOG_LEVEL}, RELAY_ADDR=${config.RELAY_ADDR}`);
      } catch (configError) {
        logger.error('WORKER:CONFIG_ERROR', `Failed to initialize config: ${configError.message}`);
        return new Response('Internal Server Error: Configuration failed', { status: 500 });
      }

      try {
        logger.setLogLevel(config.LOG_LEVEL);
        logger.debug('WORKER:LOG_LEVEL_SET', `Log level set to: ${config.LOG_LEVEL}`);
      } catch (logError) {
        logger.error('WORKER:LOG_LEVEL_ERROR', `Failed to set log level: ${logError.message}`);
      }

      const upgradeHeader = request.headers.get('Upgrade');
      logger.trace('WORKER:UPGRADE_HEADER', `Upgrade header: ${upgradeHeader}`);

      if (upgradeHeader === 'websocket') {
        logger.info('WORKER:ROUTING', 'Handling WebSocket (VLESS) request.');
        try {
          const response = handleVlessRequest(request, config);
          logger.debug('WORKER:VLESS_SUCCESS', 'VLESS handler returned successfully');
          return response;
        } catch (vlessError) {
          logger.error('WORKER:VLESS_HANDLER_ERROR', `VLESS handler failed: ${vlessError.message}`);
          return new Response('WebSocket Upgrade Failed', { status: 500 });
        }
      } else {
        logger.info('WORKER:ROUTING', 'Handling standard HTTP request.');
        try {
          const response = handleHttpRequest(request, env, config);
          logger.debug('WORKER:HTTP_SUCCESS', 'HTTP handler returned successfully');
          return response;
        } catch (httpError) {
          logger.error('WORKER:HTTP_HANDLER_ERROR', `HTTP handler failed: ${httpError.message}`);
          return new Response('Internal Server Error', { status: 500 });
        }
      }
    } catch (err) {
      logger.error('WORKER:FATAL', `Unhandled top-level error: ${err.message}`, err.stack);
      return new Response('Internal Server Error', { status: 500 });
    }
  },
};
