// index.js
import { getConfig } from './configs.js';
import { log, generateLogId } from './logs.js';
import { handleConduitRequest } from './conduit.js';
import { handleHttpRequest } from './http.js';

// --- Configuration ---
const HOSTNAME = Deno.env.get('HOSTNAME') || '0.0.0.0';
const PORT = parseInt(Deno.env.get('PORT') || '8443', 10);

console.log(`Deno VLESS Server starting on ${HOSTNAME}:${PORT}`);
console.log('To run, use: deno run --allow-net --allow-env index.js');

/**
 * Main Deno server entry point using the native `Deno.serve` API.
 * This handler is the equivalent of the `fetch` export in Cloudflare Workers.
 */
Deno.serve({
  hostname: HOSTNAME,
  port: PORT,
  handler: async (request, info) => {
    const logId = generateLogId();
    // Get client IP from the connection info object provided by Deno.serve.
    const clientIP = info.remoteAddr.hostname;
    const logContext = { logId, clientIP, section: 'WORKER' };
    try {
      const url = new URL(request.url);
      const config = getConfig();
      const upgradeHeader = request.headers.get('Upgrade');
      log.setLogLevel(config.LOG_LEVEL);
      log.info(logContext, 'REQUEST', 'New request received.');
      if (upgradeHeader === 'websocket') {
        log.info(logContext, 'CONDUIT', 'Handling WebSocket upgrade request.');
        return handleConduitRequest(request, config, { ...logContext });
      } else {
        log.info(logContext, 'HTTP', 'Handling HTTP request.');
        return await handleHttpRequest(request, url, config, { ...logContext });
      }
    } catch (err) {
      log.error(logContext, 'ERROR', 'Top-level server error:', err.stack || err);
      return new Response(err.toString(), { status: 500 });
    }
  },
  onError: (error) => {
    console.error('Fatal server error:', error);
    return new Response('Internal Server Error', { status: 500 });
  },
});
