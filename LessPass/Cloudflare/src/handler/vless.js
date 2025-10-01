// =================================================================
// File: handler/vless.js
// Description: The VLESS Orchestrator. Manages the connection lifecycle.
// =================================================================

import { logger } from '../lib/logger.js';
import { processVlessHeader, createConsumableStream, makeReadableWebSocketStream } from '../lib/utils.js';
import { handleTcpProxy } from '../protocol/tcp.js';
import { handleUdpProxy } from '../protocol/udp.js';

/**
 * This function runs in the background after the WebSocket handshake is complete.
 * It reads the VLESS header and orchestrates the connection.
 * @param {WebSocket} server - The server-side of the WebSocketPair.
 * @param {Request} request - The original incoming request.
 * @param {object} logContext - The logging context.
 */
async function processVlessConnection(server, request, logContext) {
  try {
    const earlyDataHeader = request.headers.get('Sec-WebSocket-Protocol') || '';

    // Create the stream atomically, passing the early data header to the utility.
    const webSocketStream = makeReadableWebSocketStream(server, earlyDataHeader, logContext);
    const reader = webSocketStream.getReader();

    // Now this is safe. The stream will provide the first chunk from either
    // early data or the first message, with no chance of loss.
    const firstChunk = (await reader.read()).value;

    if (!firstChunk) {
      throw new Error('No data received from client after connection.');
    }

    const headerInfo = processVlessHeader(firstChunk);
    if (headerInfo.error) {
      throw new Error(headerInfo.error);
    }

    const { isUDP, address, port, rawData, vlessVersion } = headerInfo;
    logContext.remoteAddress = address;
    logContext.remotePort = port;
    const protocol = isUDP ? 'UDP' : 'TCP';
    logger.info(logContext, 'CONNECTION', `Processing ${protocol} request for ${address}:${port}`);

    // Reconstitute the full stream (initial data payload + rest of the stream).
    const consumableStream = createConsumableStream(reader, rawData);

    if (isUDP) {
      if (port !== 53) {
        throw new Error('UDP is only supported for DNS on port 53.');
      }
      handleUdpProxy(server, consumableStream, vlessVersion, logContext);
    } else {
      handleTcpProxy(server, consumableStream, address, port, vlessVersion, logContext);
    }
  } catch (err) {
    logger.error(logContext, 'ERROR', 'Error in VLESS connection processing:', err.stack || err);
    server.close(1011, 'Failed to process VLESS request.');
  }
}

/**
 * Orchestrates an incoming VLESS WebSocket request.
 * This function's primary job is to complete the WebSocket handshake immediately.
 */
export function handleVlessRequest(request, logContext) {
  const vlessLogContext = { ...logContext, section: 'VLESS_ORCHESTRATOR' };
  const { 0: client, 1: server } = new WebSocketPair();
  server.accept();

  // "Fire-and-forget" the connection processing.
  // This lets it run in the background without blocking the response.
  processVlessConnection(server, request, vlessLogContext);

  // Immediately return the 101 response to complete the handshake.
  return new Response(null, { status: 101, webSocket: client });
}
