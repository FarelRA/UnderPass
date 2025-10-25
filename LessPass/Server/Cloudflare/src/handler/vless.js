// =================================================================
// File: handler/vless.js
// Description: The VLESS Orchestrator. Manages the connection lifecycle.
// =================================================================

import { VLESS } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { handleTcpProxy } from '../protocol/tcp.js';
import { handleUdpProxy } from '../protocol/udp.js';
import { getFirstChunk, createConsumableStream, stringifyUUID } from '../lib/utils.js';

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
  logger.trace('VLESS:HANDLER', 'Handling VLESS request');

  // Create WebSocket pair (client-facing and worker-facing)
  const pair = new WebSocketPair();
  const clientWebSocket = pair[0];
  const workerWebSocket = pair[1];

  workerWebSocket.accept();
  logger.debug('VLESS:WEBSOCKET', 'WebSocket connection accepted');

  // Process VLESS connection asynchronously
  logger.info('VLESS:PROCESS', 'Starting VLESS connection processing');
  processVlessConnection(request, workerWebSocket, config).catch((err) => {
    logger.error('VLESS:PROCESS', `Connection setup failed: ${err.message}`);
    workerWebSocket.close(1011, `SETUP_ERROR: ${err.message}`);
  });

  logger.debug('VLESS:HANDLER', 'Returning 101 Switching Protocols response');
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
  // Validate minimum header length
  if (chunk.byteLength < VLESS.MIN_HEADER_LENGTH) {
    throw new Error(`Invalid VLESS header: insufficient length. Got ${chunk.byteLength}, expected at least ${VLESS.MIN_HEADER_LENGTH}.`);
  }

  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  let offset = 0;

  // === Parse VLESS Version (1 byte) ===
  const vlessVersion = chunk.subarray(offset, VLESS.VERSION_LENGTH);
  offset += VLESS.VERSION_LENGTH;

  // === Parse User ID (16 bytes UUID) ===
  const userID = stringifyUUID(chunk.subarray(offset, offset + VLESS.USERID_LENGTH));
  offset += VLESS.USERID_LENGTH;

  // === Parse Addon Section (variable length) ===
  const addonLength = chunk[offset];
  offset += 1 + addonLength;

  if (offset >= chunk.byteLength) {
    throw new Error('Header truncated after addon section');
  }

  // === Parse Command (1 byte) ===
  const command = chunk[offset++];
  const protocol = command === VLESS.COMMAND.TCP ? 'TCP' : command === VLESS.COMMAND.UDP ? 'UDP' : null;

  if (!protocol) {
    throw new Error(`Unsupported VLESS command: ${command}`);
  }

  // === Parse Port (2 bytes, big-endian) ===
  if (offset + 2 > chunk.byteLength) {
    throw new Error('Header truncated before port');
  }

  const port = view.getUint16(offset);
  offset += 2;

  // === Parse Address (variable length based on type) ===
  if (offset >= chunk.byteLength) {
    throw new Error('Header truncated before address type');
  }

  const addressType = chunk[offset++];
  const address = parseAddress(chunk, view, addressType, offset);
  offset = address.newOffset;

  // === Extract Remaining Payload ===
  const payload = chunk.subarray(offset);

  return {
    vlessVersion,
    userID,
    protocol,
    address: address.value,
    port,
    payload,
  };
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
  logger.trace('VLESS:PROCESS', 'Processing VLESS connection');

  // === Step 1: Get First Data Chunk ===
  logger.debug('VLESS:STREAM', 'Getting first chunk from WebSocket');
  const firstChunk = await getFirstChunk(request, clientWebSocket);
  logger.debug('VLESS:STREAM', `Received first chunk: ${firstChunk.byteLength} bytes`);

  // === Step 2: Create Stream for Subsequent Data ===
  const wsStream = createConsumableStream(clientWebSocket);
  logger.debug('VLESS:STREAM', 'Created consumable stream');

  // === Step 3: Parse VLESS Header ===
  logger.debug('VLESS:HEADER', 'Parsing VLESS header');
  const { vlessVersion, userID, protocol, address, port, payload } = processVlessHeader(firstChunk);
  logger.debug('VLESS:HEADER', `Parsed: ${protocol} to ${address}:${port}, payload ${payload.byteLength} bytes`);

  // === Step 4: Authenticate User ===
  if (userID !== config.USER_ID) {
    logger.warn('VLESS:AUTH', `Authentication failed: expected ${config.USER_ID}, got ${userID}`);
    throw new Error(`Invalid user ID. Expected: ${config.USER_ID}, Got: ${userID}`);
  }
  logger.info('VLESS:AUTH', `User authenticated: ${userID}`);

  // === Step 5: Update Logging Context ===
  logger.updateLogContext({ remoteAddress: address, remotePort: port });
  logger.info('VLESS:CONNECTION', `Processing ${protocol} request to ${address}:${port}`);

  // === Step 6: Send VLESS Handshake Response ===
  logger.debug('VLESS:HANDSHAKE', 'Sending VLESS handshake response to client');
  clientWebSocket.send(vlessResponse);

  // === Step 7: Dispatch to Protocol Handler ===
  if (protocol === 'TCP') {
    logger.debug('VLESS:DISPATCH', 'Dispatching to TCP proxy handler');
    await handleTcpProxy(address, port, clientWebSocket, payload, wsStream, config);
  } else {
    // UDP only supports DNS (port 53)
    if (port !== 53) {
      logger.error('VLESS:DISPATCH', `UDP only supports port 53, got port ${port}`);
      throw new Error(`UDP is only supported for DNS on port 53, got port ${port}`);
    }
    logger.debug('VLESS:DISPATCH', 'Dispatching to UDP proxy handler');
    await handleUdpProxy(clientWebSocket, payload, wsStream, config);
  }

  logger.info('VLESS:PROCESS', `${protocol} proxy completed successfully`);
}
  }

  logger.info('VLESS:PROCESS', `${protocol} proxy completed successfully`);
}

/**
 * Parses the address field from the VLESS header based on address type.
 * Supports IPv4, IPv6, and FQDN (Fully Qualified Domain Name).
 *
 * @param {Uint8Array} chunk - The data chunk containing the address.
 * @param {DataView} view - DataView for reading multi-byte values.
 * @param {number} addressType - The type of address (1=IPv4, 2=FQDN, 3=IPv6).
 * @param {number} offset - Current offset in the chunk.
 * @returns {{value: string, newOffset: number}} The parsed address and updated offset.
 * @throws {Error} If address data is insufficient or invalid.
 */
function parseAddress(chunk, view, addressType, offset) {
  switch (addressType) {
    case VLESS.ADDRESS_TYPE.IPV4: {
      if (offset + 4 > chunk.byteLength) {
        throw new Error('Insufficient data for IPv4 address');
      }
      const address = `${chunk[offset]}.${chunk[offset + 1]}.${chunk[offset + 2]}.${chunk[offset + 3]}`;
      return { value: address, newOffset: offset + 4 };
    }

    case VLESS.ADDRESS_TYPE.FQDN: {
      if (offset >= chunk.byteLength) {
        throw new Error('Insufficient data for FQDN length');
      }
      const domainLength = chunk[offset++];

      if (offset + domainLength > chunk.byteLength) {
        throw new Error('Insufficient data for FQDN');
      }
      const address = textDecoder.decode(chunk.subarray(offset, offset + domainLength));
      return { value: address, newOffset: offset + domainLength };
    }

    case VLESS.ADDRESS_TYPE.IPV6: {
      if (offset + 16 > chunk.byteLength) {
        throw new Error('Insufficient data for IPv6 address');
      }
      // Build IPv6 address string directly
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
