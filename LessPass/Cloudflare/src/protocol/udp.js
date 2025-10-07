// =================================================================
// File: protocol/udp.js
// Description: Handles proxying UDP via DNS-over-HTTPS.
// =================================================================

import { logger } from '../lib/logger.js';
import { safeCloseWebSocket } from '../lib/utils.js';

/**
 * Main handler for UDP proxying. Its primary responsibilities are to perform
 * the initial VLESS handshake and orchestrate the main proxying loop.
 * @param {WebSocket} webSocket The client WebSocket.
 * @param {Uint8Array} initialPayload The payload from VLESS header parsing.
 * @param {ReadableStream} wsStream The WebSocket message stream.
 * @param {Uint8Array} vlessVersion VLESS version bytes.
 * @param {object} config The request-scoped configuration.
 * @param {object} logContext Logging context.
 */
export async function handleUdpProxy(webSocket, initialPayload, wsStream, vlessVersion, config, logContext) {
  const udpLogContext = { ...logContext, section: 'UDP_PROXY' };

  if (!webSocket) {
    throw new Error('WebSocket is required');
  }
  if (!initialPayload || !(initialPayload instanceof Uint8Array)) {
    throw new Error('initialPayload must be a Uint8Array');
  }
  if (!wsStream) {
    throw new Error('wsStream is required');
  }
  if (!vlessVersion || !(vlessVersion instanceof Uint8Array)) {
    throw new Error('vlessVersion must be a Uint8Array');
  }
  if (!config || !config.DOH_URL) {
    throw new Error('config with DOH_URL is required');
  }

  try {
    try {
      webSocket.send(new Uint8Array([vlessVersion[0], 0]));
    } catch (sendError) {
      throw new Error(`Failed to send VLESS handshake: ${sendError.message}`);
    }

    await proxyUdpOverDoH(webSocket, initialPayload, wsStream, config, udpLogContext);
  } catch (error) {
    logger.error(udpLogContext, 'UDP:FATAL_ERROR', `An unrecoverable error occurred in the UDP handler: ${error.message}`);
  } finally {
    safeCloseWebSocket(webSocket, udpLogContext);
  }
}

/**
 * The main proxying loop for UDP. It sets up a stream pipeline to listen for
 * client packets and process them individually.
 * This function is the architectural equivalent of TCP's `attemptConnection`.
 * @param {WebSocket} webSocket The client WebSocket.
 * @param {Uint8Array} initialPayload The payload from VLESS header parsing.
 * @param {ReadableStream} wsStream The WebSocket message stream.
 * @param {object} config The request-scoped configuration.
 * @param {object} logContext Logging context.
 */
async function proxyUdpOverDoH(webSocket, initialPayload, wsStream, config, logContext) {
  const processChunk = async (chunk) => {
    if (!chunk || !(chunk instanceof Uint8Array)) {
      logger.warn(logContext, 'UDP:INVALID_CHUNK', 'Received invalid chunk data');
      return;
    }

    let view;
    try {
      view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    } catch (viewError) {
      logger.error(logContext, 'UDP:VIEW_ERROR', `Failed to create DataView: ${viewError.message}`);
      return;
    }

    for (let offset = 0; offset < chunk.byteLength; ) {
      if (offset + 2 > chunk.byteLength) {
        logger.warn(logContext, 'UDP:PARSE', 'Incomplete length header in VLESS UDP chunk.');
        break;
      }

      let length;
      try {
        length = view.getUint16(offset);
      } catch (lengthError) {
        logger.error(logContext, 'UDP:LENGTH_ERROR', `Failed to read length: ${lengthError.message}`);
        break;
      }

      offset += 2;
      if (offset + length > chunk.byteLength) {
        logger.warn(logContext, 'UDP:PARSE', 'Incomplete VLESS UDP packet payload.');
        break;
      }

      try {
        await processDnsPacket(chunk.slice(offset, offset + length), webSocket, config, logContext);
      } catch (packetError) {
        logger.error(logContext, 'UDP:PACKET_PROCESS_ERROR', `Failed to process packet: ${packetError.message}`);
      }

      offset += length;
    }
  };

  if (initialPayload && initialPayload.byteLength > 0) {
    try {
      await processChunk(initialPayload);
    } catch (chunkError) {
      logger.error(logContext, 'UDP:INITIAL_CHUNK_ERROR', `Failed to process initial payload: ${chunkError.message}`);
    }
  }

  let reader;
  try {
    reader = wsStream.getReader();
  } catch (readerError) {
    throw new Error(`Failed to get stream reader: ${readerError.message}`);
  }

  try {
    while (true) {
      let result;
      try {
        result = await reader.read();
      } catch (readError) {
        logger.error(logContext, 'UDP:READ_ERROR', `Failed to read from stream: ${readError.message}`);
        break;
      }

      const { value, done } = result;
      if (done) {
        logger.info(logContext, 'UDP:CLOSE', 'Client UDP stream closed.');
        break;
      }

      try {
        await processChunk(value);
      } catch (chunkError) {
        logger.error(logContext, 'UDP:CHUNK_ERROR', `Failed to process chunk: ${chunkError.message}`);
      }
    }
  } catch (error) {
    logger.warn(logContext, 'UDP:ABORT', `Client UDP stream aborted: ${error.message}`);
  } finally {
    try {
      reader.releaseLock();
    } catch (lockError) {
      logger.warn(logContext, 'UDP:LOCK_ERROR', `Failed to release lock: ${lockError.message}`);
    }
  }
}

/**
 * Processes a single DNS packet. It forwards the query to the DoH server
 * and sends the VLESS-formatted response back to the client.
 * This is the core "unit of work" for the UDP proxy.
 * @param {Uint8Array} dnsQuery The raw DNS query payload.
 * @param {WebSocket} webSocket The client WebSocket.
 * @param {object} config The request-scoped configuration.
 * @param {object} logContext Logging context.
 */
async function processDnsPacket(dnsQuery, webSocket, config, logContext) {
  if (!dnsQuery || !(dnsQuery instanceof Uint8Array)) {
    logger.error(logContext, 'UDP:INVALID_QUERY', 'DNS query must be a Uint8Array');
    return;
  }

  if (!webSocket) {
    logger.error(logContext, 'UDP:NO_WEBSOCKET', 'WebSocket is null/undefined');
    return;
  }

  if (!config || !config.DOH_URL) {
    logger.error(logContext, 'UDP:NO_DOH_URL', 'DOH_URL is not configured');
    return;
  }

  try {
    let response;
    try {
      response = await fetch(config.DOH_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/dns-message' },
        body: dnsQuery,
      });
    } catch (fetchError) {
      throw new Error(`DoH fetch failed: ${fetchError.message}`);
    }

    if (!response) {
      throw new Error('DoH response is null/undefined');
    }

    if (!response.ok) {
      let errorText = 'Unknown error';
      try {
        errorText = await response.text();
      } catch (textError) {
        logger.warn(logContext, 'UDP:TEXT_ERROR', `Failed to read error text: ${textError.message}`);
      }
      throw new Error(`DoH request failed with status ${response.status}: ${errorText}`);
    }

    let arrayBuffer;
    try {
      arrayBuffer = await response.arrayBuffer();
    } catch (bufferError) {
      throw new Error(`Failed to read response buffer: ${bufferError.message}`);
    }

    if (!arrayBuffer) {
      throw new Error('Response arrayBuffer is null/undefined');
    }

    const dnsResult = new Uint8Array(arrayBuffer);
    const resultSize = dnsResult.byteLength;

    if (resultSize === 0) {
      logger.warn(logContext, 'UDP:EMPTY_RESPONSE', 'DoH returned empty response');
      return;
    }

    let responsePacket;
    try {
      responsePacket = new Uint8Array(2 + resultSize);
      new DataView(responsePacket.buffer).setUint16(0, resultSize);
      responsePacket.set(dnsResult, 2);
    } catch (packetError) {
      throw new Error(`Failed to create response packet: ${packetError.message}`);
    }

    try {
      webSocket.send(responsePacket);
    } catch (sendError) {
      throw new Error(`Failed to send response: ${sendError.message}`);
    }
  } catch (error) {
    logger.error(logContext, 'UDP:PACKET_ERROR', `Failed to process DNS packet: ${error.message}`);
  }
}
