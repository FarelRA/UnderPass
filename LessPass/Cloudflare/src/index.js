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
    logger.trace({ section: 'WORKER' }, 'ENTRY', 'Worker fetch handler invoked');

    try {
      if (!request || !request.url) {
        logger.error({ section: 'WORKER' }, 'INVALID_REQUEST', 'Request or request.url is null/undefined');
        return new Response('Bad Request', { status: 400 });
      }

      logger.debug({ section: 'WORKER' }, 'REQUEST_VALID', `Request URL: ${request.url}, Method: ${request.method}`);

      let url;
      try {
        url = new URL(request.url);
        logger.trace({ section: 'WORKER' }, 'URL_PARSED', `Parsed URL - Host: ${url.host}, Path: ${url.pathname}`);
      } catch (urlError) {
        logger.error({ section: 'WORKER' }, 'URL_PARSE_ERROR', `Failed to parse URL: ${urlError.message}`);
        return new Response('Bad Request: Invalid URL', { status: 400 });
      }

      let config;
      try {
        logger.debug({ section: 'WORKER' }, 'CONFIG_INIT', 'Initializing configuration');
        config = initializeConfig(url, env);
        logger.trace({ section: 'WORKER' }, 'CONFIG_LOADED', `Config: LOG_LEVEL=${config.LOG_LEVEL}, RELAY_ADDR=${config.RELAY_ADDR}`);
      } catch (configError) {
        logger.error({ section: 'WORKER' }, 'CONFIG_ERROR', `Failed to initialize config: ${configError.message}`);
        return new Response('Internal Server Error: Configuration failed', { status: 500 });
      }

      try {
        logger.setLogLevel(config.LOG_LEVEL);
        logger.debug({ section: 'WORKER' }, 'LOG_LEVEL_SET', `Log level set to: ${config.LOG_LEVEL}`);
      } catch (logError) {
        logger.error({ section: 'WORKER' }, 'LOG_LEVEL_ERROR', `Failed to set log level: ${logError.message}`);
      }

      const upgradeHeader = request.headers.get('Upgrade');
      logger.trace({ section: 'WORKER' }, 'UPGRADE_HEADER', `Upgrade header: ${upgradeHeader}`);

      if (upgradeHeader === 'websocket') {
        logger.info({ section: 'WORKER' }, 'ROUTING', 'Handling WebSocket (VLESS) request.');
        try {
          const response = handleVlessRequest(request, config);
          logger.debug({ section: 'WORKER' }, 'VLESS_SUCCESS', 'VLESS handler returned successfully');
          return response;
        } catch (vlessError) {
          logger.error({ section: 'WORKER' }, 'VLESS_HANDLER_ERROR', `VLESS handler failed: ${vlessError.message}`);
          return new Response('WebSocket Upgrade Failed', { status: 500 });
        }
      } else {
        logger.info({ section: 'WORKER' }, 'ROUTING', 'Handling standard HTTP request.');
        try {
          const response = handleHttpRequest(request, env, config);
          logger.debug({ section: 'WORKER' }, 'HTTP_SUCCESS', 'HTTP handler returned successfully');
          return response;
        } catch (httpError) {
          logger.error({ section: 'WORKER' }, 'HTTP_HANDLER_ERROR', `HTTP handler failed: ${httpError.message}`);
          return new Response('Internal Server Error', { status: 500 });
        }
      }
    } catch (err) {
      logger.error({ section: 'WORKER' }, 'FATAL', `Unhandled top-level error: ${err.message}`, err.stack);
      return new Response('Internal Server Error', { status: 500 });
    } finally {
      logger.setLogContext({});
    }
  },
};
