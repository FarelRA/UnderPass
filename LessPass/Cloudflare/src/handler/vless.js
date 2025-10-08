// =================================================================
// File: handler/vless.js
// Description: The VLESS Orchestrator. Manages the connection lifecycle.
// =================================================================

import { VLESS } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { handleTcpProxy } from '../protocol/tcp.js';
import { handleUdpProxy } from '../protocol/udp.js';
import { getFirstChunk, createConsumableStream, stringifyUUID } from '../lib/utils.js';

const textDecoder = new TextDecoder();

export const VLESS_RESPONSE = new Uint8Array([0, 0]);

/**
 * Orchestrates an incoming VLESS WebSocket request.
 * @param {Request} request The original incoming request.
 * @param {object} config The request-scoped configuration.
 * @returns {Response} A 101 Switching Protocols response.
 */
export function handleVlessRequest(request, config) {
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  
  server.accept();

  processVlessConnection(server, request, config).catch((err) => {
    logger.error('VLESS:ERROR', err.message);
    try {
      server.close(1011, `ERROR: ${err.message}`);
    } catch {}
  });

  return new Response(null, { status: 101, webSocket: client });
}

/**
 * Reads the VLESS header, validates the user, and dispatches to the correct protocol handler.
 * @param {WebSocket} server The server-side of the WebSocketPair.
 * @param {Request} request The original incoming request.
 * @param {object} config The request-scoped configuration.
 * @returns {Promise<void>}
 * @throws {Error} If parameters are invalid, authentication fails, or protocol handling fails.
 */
async function processVlessConnection(server, request, config) {
  const firstChunk = await getFirstChunk(server, request);
  const wsStream = createConsumableStream(server);
  const { vlessVersion, userID, protocol, address, port, payload } = processVlessHeader(firstChunk);

  const userIDString = stringifyUUID(userID);

  if (userIDString !== config.USER_ID) {
    throw new Error(`Invalid user ID`);
  }

  logger.updateLogContext({ remoteAddress: address, remotePort: port });
  logger.info('VLESS:CONN', `${protocol} ${address}:${port}`);

  server.send(new Uint8Array([vlessVersion[0], 0]));

  if (protocol === 'UDP') {
    if (port !== 53) {
      throw new Error(`UDP only supports port 53`);
    }
    await handleUdpProxy(server, payload, wsStream, config);
  } else {
    await handleTcpProxy(server, payload, wsStream, address, port, config);
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

  const vlessVersion = chunk.subarray(offset, VLESS.VERSION_LENGTH);
  offset += VLESS.VERSION_LENGTH;

  const userID = chunk.subarray(offset, offset + VLESS.USERID_LENGTH);
  offset += VLESS.USERID_LENGTH;

  const addonLength = chunk[offset];
  offset += 1 + addonLength;

  if (offset >= chunk.byteLength) {
    throw new Error('Header truncated after addon section');
  }

  const command = chunk[offset++];
  const protocol = command === VLESS.COMMAND.TCP ? 'TCP' : command === VLESS.COMMAND.UDP ? 'UDP' : null;
  if (!protocol) {
    throw new Error(`Unsupported VLESS command: ${command}`);
  }

  if (offset + 2 > chunk.byteLength) {
    throw new Error('Header truncated before port');
  }

  const port = view.getUint16(offset);
  offset += 2;

  if (offset >= chunk.byteLength) {
    throw new Error('Header truncated before address type');
  }

  const addressType = chunk[offset++];
  let address;

  switch (addressType) {
    case VLESS.ADDRESS_TYPE.IPV4:
      if (offset + 4 > chunk.byteLength) {
        throw new Error('Insufficient data for IPv4 address');
      }
      address = `${chunk[offset]}.${chunk[offset + 1]}.${chunk[offset + 2]}.${chunk[offset + 3]}`;
      offset += 4;
      break;
    case VLESS.ADDRESS_TYPE.FQDN:
      if (offset >= chunk.byteLength) {
        throw new Error('Insufficient data for FQDN length');
      }
      const domainLength = chunk[offset++];
      if (offset + domainLength > chunk.byteLength) {
        throw new Error('Insufficient data for FQDN');
      }
      address = textDecoder.decode(chunk.subarray(offset, offset + domainLength));
      offset += domainLength;
      break;
    case VLESS.ADDRESS_TYPE.IPV6:
      if (offset + 16 > chunk.byteLength) {
        throw new Error('Insufficient data for IPv6 address');
      }
      address = `[${view.getUint16(offset).toString(16)}:${view.getUint16(offset + 2).toString(16)}:${view.getUint16(offset + 4).toString(16)}:${view.getUint16(offset + 6).toString(16)}:${view.getUint16(offset + 8).toString(16)}:${view.getUint16(offset + 10).toString(16)}:${view.getUint16(offset + 12).toString(16)}:${view.getUint16(offset + 14).toString(16)}]`;
      offset += 16;
      break;
    default:
      throw new Error(`Invalid address type: ${addressType}`);
  }

  const payload = chunk.subarray(offset);

  return { vlessVersion, userID, protocol, address, port, payload };
}
