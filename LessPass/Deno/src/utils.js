// utils.js
import { WS_READY_STATE_CLOSING, WS_READY_STATE_OPEN, byteToHex } from './configs.js';
import { log } from './logs.js';

/**
 * Creates a helper object to read sequential data from a buffer, improving
 * readability and maintainability over manual index tracking.
 */
function createBufferReader(buffer) {
  const view = new DataView(buffer);
  let offset = 0;
  return {
    get offset() {
      return offset;
    },
    readUint8() {
      const value = view.getUint8(offset);
      offset += 1;
      return value;
    },
    readUint16() {
      const value = view.getUint16(offset);
      offset += 2;
      return value;
    },
    readBytes(length) {
      const value = new Uint8Array(buffer, offset, length);
      offset += length;
      return value;
    },
    skip(length) {
      offset += length;
    },
  };
}

/**
 * Safely closes a WebSocket, checking its state to prevent errors.
 */
export function safeCloseWebSocket(socket, baseLogContext) {
  const logContext = { ...baseLogContext, section: 'UTILS' };
  try {
    if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
      socket.close();
    }
  } catch (error) {
    log.error(logContext, 'safeCloseWebSocket:ERROR', 'Error during WebSocket close:', error.message);
  }
}

/**
 * Creates a ReadableStream from a WebSocket. This is the correct implementation
 * for Deno, adapting the event-driven WebSocket API (`onmessage`, `onclose`)
 * to the modern Streams API.
 *
 * @param {WebSocket} webSocket - The Deno WebSocket object.
 * @param {string} earlyDataHeader - The base64-encoded early data.
 * @param {object} baseLogContext - The base logging context.
 * @returns {ReadableStream} A ReadableStream of the WebSocket data.
 */
export function makeReadableWebSocketStream(webSocket, earlyDataHeader, baseLogContext) {
  let readableStreamCancel = false;
  const logContext = { ...baseLogContext, section: 'UTILS' };

  return new ReadableStream({
    start(controller) {
      // Handle incoming messages by enqueuing them into the stream.
      webSocket.onmessage = (event) => {
        if (readableStreamCancel) return;
        controller.enqueue(event.data);
      };

      // Handle the WebSocket closing by closing the stream.
      webSocket.onclose = () => {
        safeCloseWebSocket(webSocket, logContext);
        if (readableStreamCancel) return;
        controller.close();
      };

      // Handle WebSocket errors by propagating them to the stream.
      webSocket.onerror = (err) => {
        log.error(logContext, 'makeReadableWebSocketStream:ERROR', 'WebSocket error:', err);
        controller.error(err);
      };

      // Process and enqueue early data if it exists.
      const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader, baseLogContext);
      if (error) {
        controller.error(error);
      } else if (earlyData) {
        controller.enqueue(earlyData);
      }
    },

    cancel(reason) {
      if (readableStreamCancel) return;
      log.info(logContext, 'makeReadableWebSocketStream:CANCEL', `ReadableStream canceled: ${reason}`);
      readableStreamCancel = true;
      safeCloseWebSocket(webSocket, baseLogContext);
    },
  });
}

/**
 * Processes the VLESS protocol header from a buffer using the BufferReader
 * for improved readability.
 */
export function processStreamHeader(streamBuffer, userID) {
  if (streamBuffer.byteLength < 24) {
    return { hasError: true, message: 'Invalid data: insufficient length.' };
  }
  const reader = createBufferReader(streamBuffer);
  const streamVersion = reader.readBytes(1);
  const userIdBuffer = reader.readBytes(16);
  if (stringifyUUID(userIdBuffer) !== userID) {
    return { hasError: true, message: 'Invalid user ID.' };
  }
  const optLength = reader.readUint8();
  reader.skip(optLength);
  const command = reader.readUint8();
  let isUDP = false;
  if (command === 2) {
    isUDP = true;
  } else if (command !== 1) {
    return { hasError: true, message: `Unsupported command: ${command}. TCP (0x01) and UDP (0x02) are supported.` };
  }
  const portRemote = reader.readUint16();
  const addressType = reader.readUint8();
  let addressValue = '';
  switch (addressType) {
    case 1:
      addressValue = reader.readBytes(4).join('.');
      break;
    case 2:
      const domainLength = reader.readUint8();
      addressValue = new TextDecoder().decode(reader.readBytes(domainLength));
      break;
    case 3:
      const ipv6Bytes = reader.readBytes(16);
      const ipv6View = new DataView(ipv6Bytes.buffer, ipv6Bytes.byteOffset, ipv6Bytes.byteLength);
      const ipv6 = Array.from({ length: 8 }, (_, i) => ipv6View.getUint16(i * 2).toString(16));
      addressValue = `[${ipv6.join(':')}]`;
      break;
    default:
      return { hasError: true, message: `Invalid address type: ${addressType}.` };
  }
  if (!addressValue) {
    return { hasError: true, message: `Address value is empty for address type: ${addressType}.` };
  }
  return {
    hasError: false,
    addressRemote: addressValue,
    addressType,
    portRemote,
    rawDataIndex: reader.offset,
    streamVersion: streamVersion,
    isUDP,
  };
}

/**
 * Decodes a URL-safe base64 string to an ArrayBuffer.
 */
export function base64ToArrayBuffer(base64Str, baseLogContext) {
  const logContext = { ...baseLogContext, section: 'UTILS' };
  if (!base64Str) {
    return { earlyData: null, error: null };
  }
  try {
    base64Str = base64Str.replace(/-/g, '+').replace(/_/g, '/');
    const decode = atob(base64Str);
    const arryBuffer = Uint8Array.from(decode, (c) => c.charCodeAt(0));
    return { earlyData: arryBuffer.buffer, error: null };
  } catch (error) {
    log.error(logContext, 'base64ToArrayBuffer:ERROR', 'Error in base64ToArrayBuffer', error);
    return { earlyData: null, error };
  }
}

/**
 * Checks if a string is a valid UUIDv4.
 */
export function isValidUUID(uuid) {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

/**
 * Converts a Uint8Array to a UUID string.
 */
export function stringifyUUID(arr, offset = 0) {
  const uuid =
    byteToHex[arr[offset]] +
    byteToHex[arr[offset + 1]] +
    byteToHex[arr[offset + 2]] +
    byteToHex[arr[offset + 3]] +
    '-' +
    byteToHex[arr[offset + 4]] +
    byteToHex[arr[offset + 5]] +
    '-' +
    byteToHex[arr[offset + 6]] +
    byteToHex[arr[offset + 7]] +
    '-' +
    byteToHex[arr[offset + 8]] +
    byteToHex[arr[offset + 9]] +
    '-' +
    byteToHex[arr[offset + 10]] +
    byteToHex[arr[offset + 11]] +
    byteToHex[arr[offset + 12]] +
    byteToHex[arr[offset + 13]] +
    byteToHex[arr[offset + 14]] +
    byteToHex[arr[offset + 15]];
  if (!isValidUUID(uuid)) {
    throw TypeError('Stringified UUID is invalid: ' + uuid);
  }
  return uuid;
}
