// =================================================================
// File: handler/vless.js
// Description: VLESS protocol handler. Manages WebSocket connections,
//              parses VLESS headers, authenticates users, and dispatches
//              to TCP or UDP proxy handlers.
// =================================================================

import { VLESS } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { handleTcpProxy } from '../protocol/tcp.js';
import { handleUdpProxy } from '../protocol/udp.js';
import { getFirstChunk, createReadableStream, createWritableStream, stringifyUUID } from '../lib/utils.js';

// Module-level constants
const textDecoder = new TextDecoder();
const vlessResponse = new Uint8Array([0, 0]);

// === Public API ===

/**
 * Handles an incoming VLESS WebSocket request.
 * Creates a WebSocket pair, accepts the connection, and processes the VLESS protocol.
 *
 * @param {Request} request - The original HTTP request with WebSocket upgrade.
 * @param {object} config - The request-scoped configuration object.
 * @returns {Response} A 101 Switching Protocols response with the client WebSocket.
 */
export function handleVlessRequest(request, config) {
  logger.trace('VLESS:HANDLER', 'Creating WebSocket pair');
  
  // Create WebSocket pair: [0] for client, [1] for worker
  const pair = new WebSocketPair();
  const [clientWebSocket, workerWebSocket] = pair;

  // Accept the worker-side WebSocket
  workerWebSocket.accept();
  logger.debug('VLESS:WEBSOCKET', 'WebSocket connection accepted');

  // Process VLESS connection asynchronously
  logger.info('VLESS:PROCESS', 'Starting VLESS connection processing');
  processVlessConnection(request, workerWebSocket, config).catch((err) => {
    logger.error('VLESS:ERROR', `Connection failed: ${err.message}`);
    workerWebSocket.close(1011, `ERROR: ${err.message}`);
  });

  logger.debug('VLESS:HANDLER', 'Returning 101 Switching Protocols response');
  return new Response(null, { status: 101, webSocket: clientWebSocket });
}

/**
 * Processes the VLESS protocol header from a Uint8Array.
 * Parses version, user ID, command, address, port, and payload.
 *
 * @param {Uint8Array} chunk - The initial data chunk containing the VLESS header.
 * @returns {{vlessVersion: Uint8Array, userID: string, protocol: string, address: string, port: number, payload: Uint8Array}}
 *          Parsed VLESS header components.
 * @throws {Error} If the header is malformed or too short.
 */
export function processVlessHeader(chunk) {
  logger.trace('VLESS:HEADER', `Processing header (${chunk.byteLength} bytes)`);
  
  // Validate minimum header length
  if (chunk.byteLength < VLESS.MIN_HEADER_LENGTH) {
    const error = `Invalid VLESS header: insufficient length. Got ${chunk.byteLength}, expected at least ${VLESS.MIN_HEADER_LENGTH}`;
    logger.error('VLESS:HEADER', error);
    throw new Error(error);
  }

  let offset = 0;
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);

  // Parse VLESS Version (1 byte)
  const vlessVersion = chunk.subarray(offset, VLESS.VERSION_LENGTH);
  offset += VLESS.VERSION_LENGTH;
  logger.trace('VLESS:HEADER', `Version: ${vlessVersion[0]}`);

  // Parse User ID (16 bytes UUID)
  const userID = stringifyUUID(chunk.subarray(offset, offset + VLESS.USERID_LENGTH));
  offset += VLESS.USERID_LENGTH;
  logger.trace('VLESS:HEADER', `User ID: ${userID}`);

  // Parse Addon Section (variable length)
  const addonLength = chunk[offset];
  offset += 1 + addonLength;
  logger.trace('VLESS:HEADER', `Addon length: ${addonLength}`);

  // Parse Command (1 byte)
  const command = chunk[offset++];
  const protocol = command === VLESS.COMMAND.TCP ? 'TCP' : command === VLESS.COMMAND.UDP ? 'UDP' : null;
  logger.debug('VLESS:HEADER', `Protocol: ${protocol} (command: ${command})`);

  // Parse Port (2 bytes, big-endian)
  const port = view.getUint16(offset);
  offset += 2;

  // Parse Address (variable length based on type)
  const addressType = chunk[offset++];
  const parsedAddress = parseAddress(chunk, view, addressType, offset);
  const address = parsedAddress.value;
  offset = parsedAddress.newOffset;
  logger.debug('VLESS:HEADER', `Destination: ${address}:${port}`);

  // Extract remaining payload
  const payload = chunk.subarray(offset);
  logger.debug('VLESS:HEADER', `Payload size: ${payload.byteLength} bytes`);

  return { vlessVersion, userID, protocol, address, port, payload };
}

// === Private Helper Functions ===

/**
 * Processes a VLESS connection: reads header, authenticates, and dispatches to protocol handler.
 *
 * @param {Request} request - The original incoming request.
 * @param {WebSocket} clientWebSocket - The worker-side of the WebSocketPair.
 * @param {object} config - The request-scoped configuration.
 * @returns {Promise<void>}
 * @throws {Error} If authentication fails or protocol handling fails.
 */
async function processVlessConnection(request, clientWebSocket, config) {
  logger.trace('VLESS:PROCESS', 'Starting connection processing');

  // Get first chunk from WebSocket
  logger.debug('VLESS:STREAM', 'Reading first chunk from WebSocket');
  const firstChunk = await getFirstChunk(request, clientWebSocket);
  logger.debug('VLESS:STREAM', `Received first chunk: ${firstChunk.byteLength} bytes`);

  // Create readable and writable streams for subsequent data
  logger.trace('VLESS:STREAM', 'Creating readable and writable streams');
  const wsReadable = createReadableStream(clientWebSocket);
  const wsWritable = createWritableStream(clientWebSocket);
  logger.debug('VLESS:STREAM', 'Streams created successfully');

  // Parse VLESS header
  logger.debug('VLESS:HEADER', 'Parsing VLESS header');
  const { userID, protocol, address, port, payload } = processVlessHeader(firstChunk);

  // Authenticate user
  logger.debug('VLESS:AUTH', `Authenticating user: ${userID}`);
  if (userID !== config.USER_ID) {
    const error = `Authentication failed. Expected: ${config.USER_ID}, Got: ${userID}`;
    logger.warn('VLESS:AUTH', error);
    throw new Error(error);
  }
  logger.info('VLESS:AUTH', `User authenticated successfully: ${userID}`);

  // Update logging context with remote address
  logger.updateLogContext({ remoteAddress: address, remotePort: port });
  logger.info('VLESS:CONNECTION', `${protocol} request to ${address}:${port}`);

  // Send VLESS handshake response
  logger.debug('VLESS:HANDSHAKE', 'Sending handshake response to client');
  const writer = wsWritable.getWriter();
  await writer.write(vlessResponse);
  writer.releaseLock();
  logger.trace('VLESS:HANDSHAKE', 'Handshake response sent');

  // Dispatch to appropriate protocol handler
  if (protocol === 'TCP') {
    logger.info('VLESS:DISPATCH', 'Dispatching to TCP proxy handler');
    await handleTcpProxy(address, port, wsReadable, wsWritable, payload, config);
  } else if (protocol === 'UDP') {
    // UDP only supports DNS (port 53)
    if (port !== 53) {
      const error = `UDP only supports DNS on port 53, got port ${port}`;
      logger.error('VLESS:DISPATCH', error);
      throw new Error(error);
    }
    logger.info('VLESS:DISPATCH', 'Dispatching to UDP proxy handler');
    await handleUdpProxy(wsReadable, wsWritable, payload, config);
  } else {
    const error = `Unsupported protocol: ${protocol}`;
    logger.error('VLESS:DISPATCH', error);
    throw new Error(error);
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
 * @throws {Error} If address type is invalid.
 */
function parseAddress(chunk, view, addressType, offset) {
  logger.trace('VLESS:ADDRESS', `Parsing address type: ${addressType}`);
  
  switch (addressType) {
    case VLESS.ADDRESS_TYPE.IPV4: {
      const address = `${chunk[offset]}.${chunk[offset + 1]}.${chunk[offset + 2]}.${chunk[offset + 3]}`;
      logger.trace('VLESS:ADDRESS', `IPv4: ${address}`);
      return { value: address, newOffset: offset + 4 };
    }

    case VLESS.ADDRESS_TYPE.FQDN: {
      const domainLength = chunk[offset++];
      const address = textDecoder.decode(chunk.subarray(offset, offset + domainLength));
      logger.trace('VLESS:ADDRESS', `FQDN: ${address}`);
      return { value: address, newOffset: offset + domainLength };
    }

    case VLESS.ADDRESS_TYPE.IPV6: {
      const address = `[${view.getUint16(offset).toString(16)}:${view.getUint16(offset + 2).toString(16)}:${view
        .getUint16(offset + 4)
        .toString(16)}:${view.getUint16(offset + 6).toString(16)}:${view.getUint16(offset + 8).toString(16)}:${view
        .getUint16(offset + 10)
        .toString(16)}:${view.getUint16(offset + 12).toString(16)}:${view.getUint16(offset + 14).toString(16)}]`;
      logger.trace('VLESS:ADDRESS', `IPv6: ${address}`);
      return { value: address, newOffset: offset + 16 };
    }

    default: {
      const error = `Invalid address type: ${addressType}`;
      logger.error('VLESS:ADDRESS', error);
      throw new Error(error);
    }
  }
}
