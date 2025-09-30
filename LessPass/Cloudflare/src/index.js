// index.js
import { getConfig } from './configs.js';
import { log, generateLogId } from './logs.js';
import { handleSession } from './session.js';
import { handleHttpRequest } from './http.js';

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
      const config = getConfig(url, env);
      log.setLogLevel(config.LOG_LEVEL);

      if (request.headers.get('Upgrade') === 'websocket') {
        log.info(logContext, 'SESSION', 'Handling WebSocket upgrade request.');
        return handleSession(request, config, logContext);
      } else {
        log.info(logContext, 'HTTP', 'Handling HTTP request.');
        return handleHttpRequest(request, env, url, config, logContext);
      }
    } catch (err) {
      log.error(logContext, 'ERROR', 'Top-level fetch error:', err.stack || err);
      return new Response(err.toString(), { status: 500 });
    }
  },
};
