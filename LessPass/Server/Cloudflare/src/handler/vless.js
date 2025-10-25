// =================================================================
// File: handler/vless.js
// Description: The VLESS Orchestrator. Manages the connection lifecycle.
// =================================================================

import { VLESS } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { handleTcpProxy } from '../protocol/tcp.js';
import { handleUdpProxy } from '../protocol/udp.js';
import { getFirstChunk, createReadableStream, createWritableStream, stringifyUUID } from '../lib/utils.js';

// === Module-Level Constants ===
const textDecoder = new TextDecoder();
const vlessResponse = new Uint8Array([0, 0]);

// === Public API ===

/**
 * Orchestrates an incoming VLESS WebSocket request.
 * Creates a WebSocket pair, accepts the connection, and processes the VLESS protocol.
 *
 * @param {Request} request - The original incoming HTTP request with WebSocket upgrade.
 * @param {object} config - The request-scoped configuration object.
 * @returns {Response} A 101 Switching Protocols response with the client WebSocket.
 */
export function handleVlessRequest(request, config) {
  const pair = new WebSocketPair();
  const [clientWebSocket, workerWebSocket] = pair;

  workerWebSocket.accept();

  processVlessConnection(request, workerWebSocket, config).catch((err) => {
    logger.error('VLESS:ERROR', err.message);
    workerWebSocket.close(1011, `ERROR: ${err.message}`);
  });

  return new Response(null, { status: 101, webSocket: clientWebSocket });
}

/**
 * Processes the VLESS protocol header from a Uint8Array.
 * Parses version, user ID, command, address, port, and payload from the VLESS header.
 *
 * @param {Uint8Array} chunk - The initial data chunk from the client containing the VLESS header.
 * @returns {{vlessVersion: Uint8Array, userID: Uint8Array, protocol: string, address: string, port: number, payload: Uint8Array}}
 *          Parsed VLESS header components.
 * @throws {Error} If the header is malformed, too short, or uses unsupported options.
 */
export function processVlessHeader(chunk) {
  if (chunk.byteLength < VLESS.MIN_HEADER_LENGTH) {
    throw new Error(`Invalid VLESS header: insufficient length. Got ${chunk.byteLength}, expected at least ${VLESS.MIN_HEADER_LENGTH}.`);
  }

  let offset = 0;
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);

  // Parse VLESS Version (1 byte)
  const vlessVersion = chunk.subarray(offset, VLESS.VERSION_LENGTH);
  offset += VLESS.VERSION_LENGTH;

  // Parse User ID (16 bytes UUID)
  const userID = stringifyUUID(chunk.subarray(offset, offset + VLESS.USERID_LENGTH));
  offset += VLESS.USERID_LENGTH;

  // Parse Addon Section (variable length)
  const addonLength = chunk[offset];
  offset += 1 + addonLength;

  // Parse Command (1 byte)
  const command = chunk[offset++];
  const protocol = command === VLESS.COMMAND.TCP ? 'TCP' : command === VLESS.COMMAND.UDP ? 'UDP' : null;

  // Parse Port (2 bytes, big-endian)
  const port = view.getUint16(offset);
  offset += 2;

  // Parse Address (variable length based on type)
  const addressType = chunk[offset++];
  const parsedAddress = parseAddress(chunk, view, addressType, offset);
  const address = parsedAddress.value;
  offset = parsedAddress.newOffset;

  // Extract Remaining Payload
  const payload = chunk.subarray(offset);

  return { vlessVersion, userID, protocol, address, port, payload };
}

// === Private Helper Functions ===

/**
 * Reads the VLESS header, validates the user, and dispatches to the correct protocol handler.
 * This is the main connection processing pipeline.
 *
 * @param {Request} request - The original incoming request.
 * @param {WebSocket} clientWebSocket - The worker-side of the WebSocketPair.
 * @param {object} config - The request-scoped configuration.
 * @returns {Promise<void>}
 * @throws {Error} If authentication fails or protocol handling fails.
 */
async function processVlessConnection(request, clientWebSocket, config) {
  // Get first chunk and create streams
  const firstChunk = await getFirstChunk(request, clientWebSocket);
  const wsReadable = createReadableStream(clientWebSocket);
  const wsWritable = createWritableStream(clientWebSocket);

  // Parse and validate VLESS header
  const { userID, protocol, address, port, payload } = processVlessHeader(firstChunk);

  if (userID !== config.USER_ID) {
    throw new Error(`Authentication failed. Expected: ${config.USER_ID}, Got: ${userID}`);
  }

  logger.updateLogContext({ remoteAddress: address, remotePort: port });
  logger.info('VLESS:CONNECTION', `${protocol} request to ${address}:${port}`);

  // Send handshake response
  const writer = wsWritable.getWriter();
  await writer.write(vlessResponse);
  writer.releaseLock();

  // Dispatch to protocol handler
  if (protocol === 'TCP') {
    await handleTcpProxy(address, port, wsReadable, wsWritable, payload, config);
  } else if (protocol === 'UDP') {
    if (port !== 53) {
      throw new Error(`UDP only supports DNS on port 53, got port ${port}`);
    }
    await handleUdpProxy(wsReadable, wsWritable, payload, config);
  } else {
    throw new Error(`Unsupported protocol: ${protocol}`);
  }

  logger.info('VLESS:PROCESS', `${protocol} proxy completed`);
}

/**
 * Parses the address field from the VLESS header based on address type.
 *
 * @param {Uint8Array} chunk - The data chunk containing the address.
 * @param {DataView} view - DataView for reading multi-byte values.
 * @param {number} addressType - The type of address (1=IPv4, 2=FQDN, 3=IPv6).
 * @param {number} offset - Current offset in the chunk.
 * @returns {{value: string, newOffset: number}} The parsed address and updated offset.
 */
function parseAddress(chunk, view, addressType, offset) {
  switch (addressType) {
    case VLESS.ADDRESS_TYPE.IPV4: {
      const address = `${chunk[offset]}.${chunk[offset + 1]}.${chunk[offset + 2]}.${chunk[offset + 3]}`;
      return { value: address, newOffset: offset + 4 };
    }

    case VLESS.ADDRESS_TYPE.FQDN: {
      const domainLength = chunk[offset++];
      const address = textDecoder.decode(chunk.subarray(offset, offset + domainLength));
      return { value: address, newOffset: offset + domainLength };
    }

    case VLESS.ADDRESS_TYPE.IPV6: {
      const address = `[${view.getUint16(offset).toString(16)}:${view.getUint16(offset + 2).toString(16)}:${view
        .getUint16(offset + 4)
        .toString(16)}:${view.getUint16(offset + 6).toString(16)}:${view.getUint16(offset + 8).toString(16)}:${view
        .getUint16(offset + 10)
        .toString(16)}:${view.getUint16(offset + 12).toString(16)}:${view.getUint16(offset + 14).toString(16)}]`;
      return { value: address, newOffset: offset + 16 };
    }

    default:
      throw new Error(`Invalid address type: ${addressType}`);
  }
}
