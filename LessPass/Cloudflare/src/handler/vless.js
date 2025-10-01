// =================================================================
// File: handler/vless.js
// Description: The VLESS Orchestrator. Manages the connection lifecycle.
// =================================================================

import { VLESS } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { handleTcpProxy } from '../protocol/tcp.js';
import { handleUdpProxy } from '../protocol/udp.js';
import { createConsumableStream, getFirstChunk, stringifyUUID } from '../lib/utils.js';

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

  processVlessConnection(server, request, config, vlessLogContext).catch((err) => {
    logger.error(vlessLogContext, 'CONNECTION_SETUP_ERROR', 'Failed to process VLESS connection:', err.message);
    server.close(1011, `SETUP_ERROR: ${err.message}`);
  });

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
  const firstChunk = await getFirstChunk(server, request);

  const { vlessVersion, userID, protocol, address, port, payload } = processVlessHeader(firstChunk);
  if (stringifyUUID(userID) !== config.USER_ID) {
    throw new Error('Invalid user ID.');
  }

  logContext.remoteAddress = address;
  logContext.remotePort = port;
  logger.info(logContext, 'CONNECTION', `Processing ${protocol} request for ${address}:${port}`);

  const consumableStream = createConsumableStream(server, payload, logContext);
  if (protocol === 'UDP') {
    if (port !== 53) {
      throw new Error('UDP is only supported for DNS on port 53.');
    }
    await handleUdpProxy(server, consumableStream, vlessVersion, config, logContext);
  } else {
    await handleTcpProxy(server, consumableStream, address, port, vlessVersion, config, logContext);
  }
}

/**
 * Processes the VLESS protocol header from a Uint8Array.
 * @param {Uint8Array} chunk The initial data chunk from the client.
 * @returns {{vlessVersion: Uint8Array, userID: Uint8Array, protocol: string, address: string, port: number, payload: Uint8Array}}
 * @throws {Error} If the header is malformed, too short, or uses unsupported options.
 */
export function processVlessHeader(chunk) {
  if (chunk.byteLength < VLESS.MIN_HEADER_LENGTH) {
    throw new Error(`Invalid VLESS header: insufficient length. Got ${chunk.byteLength}, expected at least ${VLESS.MIN_HEADER_LENGTH}.`);
  }

  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  let offset = 0;

  const vlessVersion = chunk.slice(offset, VLESS.VERSION_LENGTH);
  offset += VLESS.VERSION_LENGTH;

  const userID = chunk.slice(offset, offset + VLESS.USERID_LENGTH);
  offset += VLESS.USERID_LENGTH;

  const addonLength = view.getUint8(offset);
  offset += 1 + addonLength; // Skip addon section

  const command = view.getUint8(offset);
  offset += 1;

  let protocol;
  if (command === VLESS.COMMAND.TCP) protocol = 'TCP';
  else if (command === VLESS.COMMAND.UDP) protocol = 'UDP';
  else throw new Error(`Unsupported VLESS command: ${command}`);

  const port = view.getUint16(offset);
  offset += 2;

  const addressType = view.getUint8(offset);
  offset += 1;
  let address;

  switch (addressType) {
    case VLESS.ADDRESS_TYPE.IPV4:
      address = Array.from(chunk.slice(offset, offset + 4)).join('.');
      offset += 4;
      break;
    case VLESS.ADDRESS_TYPE.FQDN:
      const domainLength = view.getUint8(offset);
      offset += 1;
      address = new TextDecoder().decode(chunk.slice(offset, offset + domainLength));
      offset += domainLength;
      break;
    case VLESS.ADDRESS_TYPE.IPV6:
      const parts = [];
      for (let i = 0; i < 8; i++) {
        parts.push(view.getUint16(offset + i * 2).toString(16));
      }
      address = `[${parts.join(':').replace(/:(:0)+:0/g, '::')}]`;
      offset += 16;
      break;
    default:
      throw new Error(`Invalid address type: ${addressType}`);
  }

  const payload = chunk.slice(offset);
  return { vlessVersion, userID, protocol, address, port, payload };
}
