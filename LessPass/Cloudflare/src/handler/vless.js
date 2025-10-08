// =================================================================
// File: handler/vless.js
// Description: The VLESS Orchestrator. Manages the connection lifecycle.
// =================================================================

import { VLESS } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { handleTcpProxy } from '../protocol/tcp.js';
import { handleUdpProxy } from '../protocol/udp.js';
import { getFirstChunk, createConsumableStream, stringifyUUID } from '../lib/utils.js';

/**
 * Orchestrates an incoming VLESS WebSocket request.
 * @param {Request} request The original incoming request.
 * @param {object} config The request-scoped configuration.
 * @returns {Response} A 101 Switching Protocols response.
 */
export function handleVlessRequest(request, config) {
  logger.trace('VLESS:ENTRY', 'handleVlessRequest called');

  try {
    if (!request) {
      logger.error('VLESS:INVALID_REQUEST', 'Request is null/undefined');
      return new Response('Bad Request', { status: 400 });
    }

    if (!config) {
      logger.error('VLESS:INVALID_CONFIG', 'Config is null/undefined');
      return new Response('Internal Server Error', { status: 500 });
    }

    logger.debug('VLESS:WS_PAIR', 'Creating WebSocket pair');
    let client, server;
    try {
      const pair = new WebSocketPair();
      client = pair[0];
      server = pair[1];
      logger.trace('VLESS:WS_PAIR', 'WebSocket pair created successfully');
    } catch (wsError) {
      logger.error('VLESS:WEBSOCKET_PAIR_ERROR', `Failed to create WebSocket pair: ${wsError.message}`);
      return new Response('WebSocket creation failed', { status: 500 });
    }

    try {
      server.accept();
      logger.debug('VLESS:WS_ACCEPT', 'WebSocket accepted');
    } catch (acceptError) {
      logger.error('VLESS:WEBSOCKET_ACCEPT_ERROR', `Failed to accept WebSocket: ${acceptError.message}`);
      return new Response('WebSocket accept failed', { status: 500 });
    }

    logger.info('VLESS:PROCESSING', 'Starting VLESS connection processing');
    processVlessConnection(server, request, config).catch((err) => {
      logger.error('VLESS:CONNECTION_SETUP_ERROR', `Failed to process VLESS connection: ${err.message}`);
      try {
        server.close(1011, `SETUP_ERROR: ${err.message}`);
      } catch (closeError) {
        logger.error('VLESS:CLOSE_ERROR', `Failed to close WebSocket after error: ${closeError.message}`);
      }
    });

    logger.debug('VLESS:RESPONSE', 'Returning 101 Switching Protocols');
    return new Response(null, { status: 101, webSocket: client });
  } catch (error) {
    logger.error('VLESS:VLESS_HANDLER_ERROR', `Unhandled error in handleVlessRequest: ${error.message}`);
    return new Response('Internal Server Error', { status: 500 });
  }
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
  logger.trace('VLESS:PROCESS', 'processVlessConnection started');

  if (!server) {
    logger.error('VLESS:NO_SERVER', 'WebSocket server is null/undefined');
    throw new Error('WebSocket server is null/undefined');
  }

  if (!request) {
    logger.error('VLESS:NO_REQUEST', 'Request is null/undefined');
    throw new Error('Request is null/undefined');
  }

  if (!config) {
    logger.error('VLESS:NO_CONFIG', 'Config is null/undefined');
    throw new Error('Config is null/undefined');
  }

  logger.debug('VLESS:STREAM_INIT', 'Getting first chunk from WebSocket');
  const firstChunk = await getFirstChunk(server, request);
  logger.debug('VLESS:FIRST_CHUNK', `Received first chunk: ${firstChunk.byteLength} bytes`);

  const wsStream = createConsumableStream(server);
  logger.debug('VLESS:STREAM_READY', 'WebSocket stream created');

  logger.debug('VLESS:HEADER_PARSE', 'Parsing VLESS header');
  let vlessVersion, userID, protocol, address, port, payload;
  try {
    const parsed = processVlessHeader(firstChunk);
    vlessVersion = parsed.vlessVersion;
    userID = parsed.userID;
    protocol = parsed.protocol;
    address = parsed.address;
    port = parsed.port;
    payload = parsed.payload;
    logger.debug('VLESS:HEADER_PARSED', `Protocol: ${protocol}, Address: ${address}:${port}, Payload: ${payload.byteLength} bytes`);
  } catch (headerError) {
    logger.error('VLESS:HEADER_ERROR', `Failed to process VLESS header: ${headerError.message}`);
    throw new Error(`Failed to process VLESS header: ${headerError.message}`);
  }

  logger.trace('VLESS:UUID_STRINGIFY', 'Converting user ID to string');
  let userIDString;
  try {
    userIDString = stringifyUUID(userID);
    logger.trace('VLESS:UUID_RESULT', `User ID: ${userIDString}`);
  } catch (uuidError) {
    logger.error('VLESS:UUID_ERROR', `Failed to stringify user ID: ${uuidError.message}`);
    throw new Error(`Failed to stringify user ID: ${uuidError.message}`);
  }

  if (userIDString !== config.USER_ID) {
    logger.warn('VLESS:AUTH_FAIL', `Invalid user ID. Expected: ${config.USER_ID}, Got: ${userIDString}`);
    throw new Error(`Invalid user ID. Expected: ${config.USER_ID}, Got: ${userIDString}`);
  }

  logger.info('VLESS:AUTH_SUCCESS', `User authenticated: ${userIDString}`);

  logger.updateLogContext({ remoteAddress: address, remotePort: port });
  logger.info('VLESS:CONNECTION', `Processing ${protocol} request for ${address}:${port}`);

  try {
    if (protocol === 'UDP') {
      if (port !== 53) {
        logger.error('VLESS:INVALID_UDP_PORT', `UDP is only supported for DNS on port 53, got port ${port}`);
        throw new Error(`UDP is only supported for DNS on port 53, got port ${port}`);
      }
      logger.debug('VLESS:UDP_PROXY', 'Dispatching to UDP proxy handler');
      await handleUdpProxy(server, payload, wsStream, vlessVersion, config);
    } else {
      logger.debug('VLESS:TCP_PROXY', 'Dispatching to TCP proxy handler');
      await handleTcpProxy(server, payload, wsStream, address, port, vlessVersion, config);
    }
    logger.info('VLESS:PROXY_COMPLETE', `${protocol} proxy completed successfully`);
  } catch (proxyError) {
    logger.error('VLESS:PROXY_ERROR', `Proxy handler failed: ${proxyError.message}`);
    throw new Error(`Proxy handler failed: ${proxyError.message}`);
  }
}

/**
 * Processes the VLESS protocol header from a Uint8Array.
 * @param {Uint8Array} chunk The initial data chunk from the client.
 * @returns {{vlessVersion: Uint8Array, userID: Uint8Array, protocol: string, address: string, port: number, payload: Uint8Array}}
 * @throws {Error} If the header is malformed, too short, or uses unsupported options.
 */
export function processVlessHeader(chunk) {
  if (!chunk || !(chunk instanceof Uint8Array)) {
    throw new Error('Chunk must be a Uint8Array');
  }

  if (chunk.byteLength < VLESS.MIN_HEADER_LENGTH) {
    throw new Error(`Invalid VLESS header: insufficient length. Got ${chunk.byteLength}, expected at least ${VLESS.MIN_HEADER_LENGTH}.`);
  }

  let view;
  try {
    view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  } catch (viewError) {
    throw new Error(`Failed to create DataView: ${viewError.message}`);
  }

  let offset = 0;

  let vlessVersion;
  try {
    vlessVersion = chunk.slice(offset, VLESS.VERSION_LENGTH);
    offset += VLESS.VERSION_LENGTH;
  } catch (error) {
    throw new Error(`Failed to extract VLESS version: ${error.message}`);
  }

  let userID;
  try {
    userID = chunk.slice(offset, offset + VLESS.USERID_LENGTH);
    offset += VLESS.USERID_LENGTH;
  } catch (error) {
    throw new Error(`Failed to extract user ID: ${error.message}`);
  }

  let addonLength;
  try {
    addonLength = chunk[offset];
    if (typeof addonLength !== 'number') {
      throw new Error('Addon length is not a number');
    }
    offset += 1 + addonLength;
  } catch (error) {
    throw new Error(`Failed to parse addon section: ${error.message}`);
  }

  if (offset >= chunk.byteLength) {
    throw new Error('Header truncated after addon section');
  }

  let command;
  try {
    command = chunk[offset];
    offset += 1;
  } catch (error) {
    throw new Error(`Failed to extract command: ${error.message}`);
  }

  const protocol = command === VLESS.COMMAND.TCP ? 'TCP' : command === VLESS.COMMAND.UDP ? 'UDP' : null;
  if (!protocol) {
    throw new Error(`Unsupported VLESS command: ${command}`);
  }

  if (offset + 2 > chunk.byteLength) {
    throw new Error('Header truncated before port');
  }

  let port;
  try {
    port = view.getUint16(offset);
    offset += 2;
  } catch (error) {
    throw new Error(`Failed to extract port: ${error.message}`);
  }

  if (offset >= chunk.byteLength) {
    throw new Error('Header truncated before address type');
  }

  let addressType;
  try {
    addressType = chunk[offset];
    offset += 1;
  } catch (error) {
    throw new Error(`Failed to extract address type: ${error.message}`);
  }

  let address;
  try {
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
        const domainLength = chunk[offset];
        offset += 1;
        if (offset + domainLength > chunk.byteLength) {
          throw new Error('Insufficient data for FQDN');
        }
        address = new TextDecoder().decode(chunk.slice(offset, offset + domainLength));
        offset += domainLength;
        break;
      case VLESS.ADDRESS_TYPE.IPV6:
        if (offset + 16 > chunk.byteLength) {
          throw new Error('Insufficient data for IPv6 address');
        }
        const parts = [];
        for (let i = 0; i < 8; i++) {
          parts.push(view.getUint16(offset + i * 2).toString(16));
        }
        address = `[${parts.join(':')}]`;
        offset += 16;
        break;
      default:
        throw new Error(`Invalid address type: ${addressType}`);
    }
  } catch (error) {
    throw new Error(`Failed to parse address: ${error.message}`);
  }

  let payload;
  try {
    payload = chunk.slice(offset);
  } catch (error) {
    throw new Error(`Failed to extract payload: ${error.message}`);
  }

  return { vlessVersion, userID, protocol, address, port, payload };
}
