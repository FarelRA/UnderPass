// =================================================================
// File: handler/vless.js
// Description: The VLESS Orchestrator. Manages the connection lifecycle.
// =================================================================

import { logger } from '../lib/logger.js';
import { base64ToArrayBuffer, processVlessHeader, createConsumableStream, makeReadableWebSocketStream } from '../lib/utils.js';
import { handleTcpProxy } from '../protocol/tcp.js';
import { handleUdpProxy } from '../protocol/udp.js';

/**
 * Orchestrates an incoming VLESS WebSocket connection.
 * It reads and parses the VLESS header, then delegates to the appropriate
 * protocol actor (TCP or UDP).
 * @param {Request} request - The incoming WebSocket upgrade request.
 * @param {object} logContext - Logging context.
 */
export async function handleVlessRequest(request, logContext) {
  const vlessLogContext = { ...logContext, section: 'VLESS_ORCHESTRATOR' };
  const { 0: client, 1: server } = new WebSocketPair();
  server.accept();

  try {
    // Use the adapter to correctly create a ReadableStream from the WebSocket.
    const webSocketStream = makeReadableWebSocketStream(server, vlessLogContext);
    const reader = webSocketStream.getReader();

    const earlyDataHeader = request.headers.get('Sec-WebSocket-Protocol') || '';
    const { earlyData } = base64ToArrayBuffer(earlyDataHeader);

    // Read the first chunk, which might be early data or from the stream.
    const firstChunk = earlyData || (await reader.read()).value;
    if (!firstChunk) {
      throw new Error('No data received from client.');
    }

    const headerInfo = processVlessHeader(firstChunk);
    if (headerInfo.error) {
      throw new Error(headerInfo.error);
    }

    const { isUDP, address, port, rawData, vlessVersion } = headerInfo;
    vlessLogContext.remoteAddress = address;
    vlessLogContext.remotePort = port;
    const protocol = isUDP ? 'UDP' : 'TCP';
    logger.info(vlessLogContext, 'CONNECTION', `Processing ${protocol} request for ${address}:${port}`);

    // Reconstitute the full stream (initial data + rest of the stream) for the actors.
    const consumableStream = createConsumableStream(reader, rawData);

    if (isUDP) {
      if (port !== 53) {
        throw new Error('UDP is only supported for DNS on port 53.');
      }
      // Don't await this, let it run in the background.
      handleUdpProxy(server, consumableStream, vlessVersion, vlessLogContext);
    } else {
      // Don't await this, let it run in the background.
      handleTcpProxy(server, consumableStream, address, port, vlessVersion, vlessLogContext);
    }
  } catch (err) {
    logger.error(vlessLogContext, 'ERROR', 'Error in VLESS handler:', err.stack || err);
    server.close(1011, 'Failed to process VLESS request.');
  }

  return new Response(null, { status: 101, webSocket: client });
}
