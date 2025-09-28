// index.js
import { getConfig } from './configs.js';
import { log, generateLogId } from './logs.js';
import { handleConduitRequest } from './conduit.js';
import { handleHttpRequest } from './http.js';

const HOSTNAME = Deno.env.get("HOSTNAME") || "0.0.0.0";
const PORT = parseInt(Deno.env.get("PORT") || "8080", 10);

console.log(`VLESS server starting on ${HOSTNAME}:${PORT}`);

Deno.serve({
  hostname: HOSTNAME,
  port: PORT,
  handler: async (request, connInfo) => {
    const logId = generateLogId();
    const clientIP = connInfo.remoteAddr.hostname;
    const logContext = { logId, clientIP, section: 'SERVER' };

    try {
      const config = getConfig();
      log.setLogLevel(config.LOG_LEVEL);

      const upgradeHeader = request.headers.get('Upgrade');
      if (upgradeHeader === 'websocket') {
        log.info(logContext, 'UPGRADE', 'Handling WebSocket upgrade request.');
        const { socket, response } = Deno.upgradeWebSocket(request);
        handleConduitRequest(socket, request, config, logContext);
        return response;
      } else {
        log.info(logContext, 'HTTP', 'Handling HTTP request.');
        return await handleHttpRequest(request, config, logContext);
      }
    } catch (err) {
      log.error(logContext, 'ERROR', 'Handler error:', err);
      return new Response(err.toString(), { status: 500 });
    }
  },
  onError(error) {
    console.error("Fatal server error:", error);
    return new Response("Internal Server Error", { status: 500 });
  },
});
