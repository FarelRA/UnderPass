// =================================================================
// File: handler/vless.js
// Description: The VLESS Orchestrator. Manages the connection lifecycle.
// =================================================================

import { logger } from '../lib/logger.js';
import {
  processVlessHeader,
  stringifyUUID,
  createConsumableStream,
  makeReadableWebSocketStream,
  safeCloseWebSocket,
} from '../lib/utils.js';
import { handleTcpProxy } from '../protocol/tcp.js';
import { handleUdpProxy } from '../protocol/udp.js';

/**
 * Orchestrates an incoming VLESS WebSocket request.
 * @param {Request} request The original incoming request.
 * @param {object} config The request-scoped configuration.
 * @param {object} logContext The logging context.
 * @returns {Response} A 101 Switching Protocols response.
 */
export function handleVlessRequest(request, config, logContext) {
  const vlessLogContext = { ...logContext, section: 'VLESS' };
  const { 0: client, 1: server } = new WebSocketPair();
  server.accept();

  // Process the connection in the background without blocking the handshake response.
  processVlessConnection(server, request, config, vlessLogContext).catch((err) => {
    logger.error(vlessLogContext, 'UNHANDLED_PROCESS_ERROR', 'Unhandled error in VLESS processing:', err);
    safeCloseWebSocket(server, vlessLogContext);
  });

  // Immediately return the 101 response to complete the WebSocket handshake.
  return new Response(null, { status: 101, webSocket: client });
}

/**
 * Reads the VLESS header, validates the user, and dispatches to the correct protocol handler.
 * @param {WebSocket} server The server-side of the WebSocketPair.
 * @param {Request} request The original incoming request.
 * @param {object} config The request-scoped configuration.
 * @param {object} logContext The logging context.
 */
async function processVlessConnection(server, request, config, logContext) {
  const earlyDataHeader = request.headers.get('Sec-WebSocket-Protocol') || '';
  const webSocketStream = makeReadableWebSocketStream(server, earlyDataHeader, logContext);
  const reader = webSocketStream.getReader();

  const { value: firstChunk, done } = await reader.read();
  if (done || !firstChunk) {
    throw new Error('No data received from client after connection.');
  }

  const headerInfo = processVlessHeader(firstChunk);
  if (headerInfo.error) {
    throw new Error(headerInfo.error);
  }

  const { vlessVersion, userID, protocol, address, port, payload } = headerInfo;

  if (stringifyUUID(userID) !== config.USER_ID) {
    throw new Error('Invalid user ID.');
  }

  logContext.remoteAddress = address;
  logContext.remotePort = port;
  logger.info(logContext, 'CONNECTION', `Processing ${protocol} request for ${address}:${port}`);

  // Reconstitute the full stream (initial data payload + rest of the stream).
  const consumableStream = createConsumableStream(reader, payload);

  if (protocol === 'UDP') {
    if (port !== 53) {
      throw new Error('UDP is only supported for DNS on port 53.');
    }
    await handleUdpProxy(server, consumableStream, vlessVersion, config, logContext);
  } else {
    await handleTcpProxy(server, consumableStream, address, port, vlessVersion, config, logContext);
  }
}
