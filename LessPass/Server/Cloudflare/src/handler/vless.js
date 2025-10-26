// =================================================================
// File: handler/vless.js
// Description: VLESS protocol handler. Manages WebSocket connections,
//              parses VLESS headers, authenticates users, and dispatches
//              to TCP or UDP proxy handlers.
// =================================================================

import { VLESS } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { proxyTcp } from '../protocol/tcp.js';
import { proxyUdp } from '../protocol/udp.js';
import { readFirstChunk, createStreams, uuidToString } from '../lib/utils.js';

// === Constants ===

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
export function handleVless(request, config) {
  logger.trace('VLESS:HANDLER', 'Creating WebSocket pair');
  
  const pair = new WebSocketPair();
  const [clientSocket, serverSocket] = pair;

  serverSocket.accept();
  logger.debug('VLESS:WEBSOCKET', 'WebSocket connection accepted');

  logger.info('VLESS:PROCESS', 'Starting VLESS connection processing');
  processVless(request, serverSocket, config).catch((err) => {
    logger.error('VLESS:ERROR', `Connection failed: ${err.message}`);
    serverSocket.close(1011, `ERROR: ${err.message}`);
  });

  logger.debug('VLESS:HANDLER', 'Returning 101 Switching Protocols response');
  return new Response(null, { status: 101, webSocket: clientSocket });
}

// === Private Helper Functions ===

/**
 * Parses the VLESS protocol header from a Uint8Array.
 * Extracts version, user ID, command, address, port, and payload.
 *
 * @param {Uint8Array} chunk - The initial data chunk containing the VLESS header.
 * @returns {{version: Uint8Array, userId: string, protocol: string, address: string, port: number, payload: Uint8Array}}
 *          Parsed VLESS header components.
 * @throws {Error} If the header is malformed or too short.
 */
function parseHeader(chunk) {
  logger.trace('VLESS:HEADER', `Processing header (${chunk.byteLength} bytes)`);

  if (chunk.byteLength < VLESS.MIN_HEADER_LENGTH) {
    const error = `Invalid VLESS header: insufficient length. Got ${chunk.byteLength}, expected at least ${VLESS.MIN_HEADER_LENGTH}`;
    logger.error('VLESS:HEADER', error);
    throw new Error(error);
  }

  let offset = 0;
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);

  // Parse version (1 byte)
  const version = chunk.subarray(offset, VLESS.VERSION_LENGTH);
  offset += VLESS.VERSION_LENGTH;
  logger.trace('VLESS:HEADER', `Version: ${version[0]}`);

  // Parse UUID (16 bytes)
  const userId = uuidToString(chunk.subarray(offset, offset + VLESS.USERID_LENGTH));
  offset += VLESS.USERID_LENGTH;
  logger.trace('VLESS:HEADER', `User ID: ${userId}`);

  // Parse addon section (variable length)
  const addonLength = chunk[offset];
  offset += 1 + addonLength;
  logger.trace('VLESS:HEADER', `Addon length: ${addonLength}`);

  // Parse command (1 byte)
  const command = chunk[offset++];
  const protocol = command === VLESS.COMMAND.TCP ? 'TCP' : command === VLESS.COMMAND.UDP ? 'UDP' : null;
  logger.debug('VLESS:HEADER', `Protocol: ${protocol} (command: ${command})`);

  // Parse port (2 bytes, big-endian)
  const port = view.getUint16(offset);
  offset += 2;

  // Parse address (variable length based on type)
  const addressType = chunk[offset++];
  const parsedAddress = parseAddress(chunk, view, addressType, offset);
  const address = parsedAddress.value;
  offset = parsedAddress.offset;
  logger.debug('VLESS:HEADER', `Destination: ${address}:${port}`);

  // Extract remaining payload
  const payload = chunk.subarray(offset);
  logger.debug('VLESS:HEADER', `Payload size: ${payload.byteLength} bytes`);

  return { version, userId, protocol, address, port, payload };
}

/**
 * Processes a VLESS connection: reads header, authenticates, and dispatches to protocol handler.
 *
 * @param {Request} request - The original incoming request.
 * @param {WebSocket} serverSocket - The server-side of the WebSocketPair.
 * @param {object} config - The request-scoped configuration.
 * @returns {Promise<void>}
 * @throws {Error} If authentication fails or protocol handling fails.
 */
async function processVless(request, serverSocket, config) {
  logger.trace('VLESS:PROCESS', 'Starting connection processing');

  // Read first chunk from WebSocket
  logger.debug('VLESS:STREAM', 'Reading first chunk from WebSocket');
  const firstChunk = await readFirstChunk(request, serverSocket);
  logger.debug('VLESS:STREAM', `Received first chunk: ${firstChunk.byteLength} bytes`);

  // Create streams for subsequent data
  logger.trace('VLESS:STREAM', 'Creating WebSocket streams');
  const clientStream = createStreams(serverSocket);
  logger.debug('VLESS:STREAM', 'Streams created successfully');

  // Parse VLESS header
  logger.debug('VLESS:HEADER', 'Parsing VLESS header');
  const { userId, protocol, address, port, payload } = parseHeader(firstChunk);

  // Authenticate user
  logger.debug('VLESS:AUTH', `Authenticating user: ${userId}`);
  if (userId !== config.USER_ID) {
    const error = `Authentication failed. Expected: ${config.USER_ID}, Got: ${userId}`;
    logger.warn('VLESS:AUTH', error);
    throw new Error(error);
  }
  logger.info('VLESS:AUTH', `User authenticated successfully: ${userId}`);

  // Update logging context with remote address
  logger.updateLogContext({ remoteAddress: address, remotePort: port });
  logger.info('VLESS:CONNECTION', `${protocol} request to ${address}:${port}`);

  // Send VLESS handshake response
  logger.debug('VLESS:HANDSHAKE', 'Sending handshake response to client');
  await clientStream.writable.write(vlessResponse);
  logger.trace('VLESS:HANDSHAKE', 'Handshake response sent');

  // Dispatch to appropriate protocol handler
  if (protocol === 'TCP') {
    logger.info('VLESS:DISPATCH', 'Dispatching to TCP proxy handler');
    await proxyTcp(address, port, clientStream, payload, config);
  } else if (protocol === 'UDP') {
    // UDP only supports DNS (port 53)
    if (port !== 53) {
      const error = `UDP only supports DNS on port 53, got port ${port}`;
      logger.error('VLESS:DISPATCH', error);
      throw new Error(error);
    }
    logger.info('VLESS:DISPATCH', 'Dispatching to UDP proxy handler');
    await proxyUdp(clientStream, payload, config);
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
 * @returns {{value: string, offset: number}} The parsed address and updated offset.
 * @throws {Error} If address type is invalid.
 */
function parseAddress(chunk, view, addressType, offset) {
  logger.trace('VLESS:ADDRESS', `Parsing address type: ${addressType}`);
  
  switch (addressType) {
    case VLESS.ADDRESS_TYPE.IPV4: {
      const address = `${chunk[offset]}.${chunk[offset + 1]}.${chunk[offset + 2]}.${chunk[offset + 3]}`;
      logger.trace('VLESS:ADDRESS', `IPv4: ${address}`);
      return { value: address, offset: offset + 4 };
    }

    case VLESS.ADDRESS_TYPE.FQDN: {
      const length = chunk[offset++];
      const address = textDecoder.decode(chunk.subarray(offset, offset + length));
      logger.trace('VLESS:ADDRESS', `FQDN: ${address}`);
      return { value: address, offset: offset + length };
    }

    case VLESS.ADDRESS_TYPE.IPV6: {
      const address = `[${view.getUint16(offset).toString(16)}:${view.getUint16(offset + 2).toString(16)}:${view
        .getUint16(offset + 4)
        .toString(16)}:${view.getUint16(offset + 6).toString(16)}:${view.getUint16(offset + 8).toString(16)}:${view
        .getUint16(offset + 10)
        .toString(16)}:${view.getUint16(offset + 12).toString(16)}:${view.getUint16(offset + 14).toString(16)}]`;
      logger.trace('VLESS:ADDRESS', `IPv6: ${address}`);
      return { value: address, offset: offset + 16 };
    }

    default: {
      const error = `Invalid address type: ${addressType}`;
      logger.error('VLESS:ADDRESS', error);
      throw new Error(error);
    }
  }
}
