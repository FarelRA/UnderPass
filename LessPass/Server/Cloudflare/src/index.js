// =================================================================
// File: index.js
// Description: Main Cloudflare Worker entry point.
// =================================================================

import { initializeConfig } from './lib/config.js';
import { logger, generateLogId } from './lib/logger.js';
import { handleHttpRequest } from './handler/http.js';
import { handleVlessRequest } from './handler/vless.js';

export default {
  async fetch(request, env) {
    const logId = generateLogId();
    const clientIP = request.headers.get('CF-Connecting-IP') || 'N/A';
    logger.setLogContext({ logId, clientIP });

    const url = new URL(request.url);
    const config = initializeConfig(url, env);
    logger.setLogLevel(config.LOG_LEVEL);

    if (request.headers.get('Upgrade') === 'websocket') {
      return handleVlessRequest(request, config);
    }

    return handleHttpRequest(request, env, config);
  },
};
