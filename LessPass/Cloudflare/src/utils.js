// utils.js
import { WS_READY_STATE_CLOSING, WS_READY_STATE_OPEN, byteToHex } from './configs.js';
import { log } from './logs.js';

/**
 * Safely closes a WebSocket. Checks the ready state before attempting to close
 * to prevent errors. Catches and logs any errors that occur during closing.
 *
 * @param {WebSocket} socket - The WebSocket to close.
 * @param {object} baseLogContext - The base logging context.
 */
export function safeCloseWebSocket(socket, baseLogContext) {
  const logContext = { ...baseLogContext, section: 'UTILS' };
  try {
    if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
      socket.close();
    }
  } catch (error) {
    log.error(logContext, 'safeCloseWebSocket:ERROR', 'Error during WebSocket close:', error);
  }
}

/**
 * Creates a ReadableStream from a WebSocket. This handles incoming messages,
 * WebSocket close events, errors, and optionally processes early data.
 *
 * @param {WebSocket} webSocketServer - The WebSocket server.
 * @param {string} earlyDataHeader - The base64-encoded early data header.
 * @param {object} baseLogContext - The base logging context.
 * @returns {ReadableStream} A ReadableStream representing the WebSocket data.
 */
export function makeReadableWebSocketStream(webSocketServer, earlyDataHeader, baseLogContext) {
  let readableStreamCancel = false; // Flag to prevent further actions after stream cancellation.
  const logContext = { ...baseLogContext, section: 'UTILS' };
  const stream = new ReadableStream({
    start(controller) {
      // Handle incoming messages.
      webSocketServer.addEventListener('message', (event) => {
        if (readableStreamCancel) return; // Ignore messages if stream is canceled.
        controller.enqueue(event.data);
      });

      // Handle WebSocket close events.
      webSocketServer.addEventListener('close', () => {
        safeCloseWebSocket(webSocketServer); // Safely close the WebSocket.
        if (readableStreamCancel) return; // Ignore if stream is canceled.
        controller.close(); // Close the ReadableStream.
      });

      // Handle WebSocket errors.
      webSocketServer.addEventListener('error', (err) => {
        log.error(logContext, 'makeReadableWebSocketStream:ERROR', 'WebSocket error:', err, err.message);
        controller.error(err); // Signal an error in the ReadableStream.
      });

      // Process early data, if any.
      const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader, baseLogContext);
      if (error) {
        controller.error(error); // If early data decoding fails, signal an error.
      } else if (earlyData) {
        controller.enqueue(earlyData); // Enqueue the decoded early data.
      }
    },

    pull(controller) {
      // Implement backpressure handling if needed. Currently, no action required.
    },

    cancel(reason) {
      // Handle stream cancellation.
      if (readableStreamCancel) return; // Prevent duplicate cancellations.
      log.info(logContext, 'makeReadableWebSocketStream:CANCEL', `ReadableStream canceled: ${reason}`);
      readableStreamCancel = true; // Set the cancellation flag.
      safeCloseWebSocket(webSocketServer, baseLogContext); // Close the WebSocket.
    },
  });
  return stream;
}

/**
 * Processes the protocol header from a buffer. Extracts information such as
 * the remote address, port, and whether it's a UDP connection. Performs
 * validation to ensure the header is well-formed and the user ID is valid.
 *
 * @param {ArrayBuffer} streamBuffer - The buffer containing the protocol header.
 * @param {string} userID - The expected user ID.
 * @returns {object} An object containing the extracted information, or an error.
 */
export function processStreamHeader(streamBuffer, userID) {
  // Validate the minimum buffer length (version + UUID + optLength + command + port + addressType).
  if (streamBuffer.byteLength < 24) {
    return {
      hasError: true,
      message: 'Invalid data: insufficient length.',
    };
  }

  // Extract components from the protocol header.
  const version = new Uint8Array(streamBuffer.slice(0, 1));
  const userIdBuffer = new Uint8Array(streamBuffer.slice(1, 17));
  let isUDP = false;

  // Validate the user ID.
  if (stringifyUUID(userIdBuffer) !== userID) {
    return { hasError: true, message: 'Invalid user ID.' };
  }

  // Read option data length, and then command.
  const optLength = new Uint8Array(streamBuffer.slice(17, 18))[0];
  const command = new Uint8Array(streamBuffer.slice(18 + optLength, 18 + optLength + 1))[0];

  // Check if it's a UDP connection (command 0x02).
  if (command === 2) {
    isUDP = true;
  } else if (command !== 1) {
    // Only TCP (0x01) and UDP (0x02) are supported.
    return { hasError: true, message: `Unsupported command: ${command}. TCP (0x01) and UDP (0x02) are supported.` };
  }

  // Extract the remote port.
  const portIndex = 18 + optLength + 1;
  const portBuffer = streamBuffer.slice(portIndex, portIndex + 2);
  const portRemote = new DataView(portBuffer).getUint16(0);

  // Extract the address type and value.
  let addressIndex = portIndex + 2;
  const addressType = new Uint8Array(streamBuffer.slice(addressIndex, addressIndex + 1))[0];
  let addressLength = 0;
  let addressValueIndex = addressIndex + 1;
  let addressValue = '';

  // Determine the address length and value based on address type.
  switch (addressType) {
    case 1: // IPv4
      addressLength = 4;
      addressValue = new Uint8Array(streamBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).join('.');
      break;
    case 2: // Domain Name
      addressLength = new Uint8Array(streamBuffer.slice(addressValueIndex, addressValueIndex + 1))[0];
      addressValueIndex += 1;
      addressValue = new TextDecoder().decode(streamBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
      break;
    case 3: // IPv6
      addressLength = 16;
      const dataView = new DataView(streamBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
      const ipv6 = [];
      for (let i = 0; i < 8; i++) {
        ipv6.push(dataView.getUint16(i * 2).toString(16));
      }
      // Wrap the IPv6 address in square brackets.
      addressValue = `[${ipv6.join(':')}]`;
      break;
    default:
      return { hasError: true, message: `Invalid address type: ${addressType}.` };
  }

  // Ensure an address value was extracted.
  if (!addressValue) {
    return { hasError: true, message: `Address value is empty for address type: ${addressType}.` };
  }

  // Return the processed header information.
  return {
    hasError: false,
    addressRemote: addressValue,
    addressType,
    portRemote,
    rawDataIndex: addressValueIndex + addressLength, // Index of data after the header.
    streamVersion: version,
    isUDP,
  };
}

/**
 * Decodes a base64 string to an ArrayBuffer. Handles URL-safe base64 encoding
 * (with '-' and '_') and catches decoding errors.
 *
 * @param {string} base64Str - The base64-encoded string.
 * @param {object} baseLogContext - The base logging context.
 * @returns {object} An object containing the decoded ArrayBuffer or an error.
 */
export function base64ToArrayBuffer(base64Str, baseLogContext) {
  const logContext = { ...baseLogContext, section: 'UTILS' };
  if (!base64Str) {
    return { earlyData: null, error: null }; // Return null if input is empty.
  }
  try {
    // Convert URL-safe base64 to standard base64.
    base64Str = base64Str.replace(/-/g, '+').replace(/_/g, '/');
    // Decode the base64 string.
    const decode = atob(base64Str);
    // Convert the decoded string to a Uint8Array.
    const arryBuffer = Uint8Array.from(decode, (c) => c.charCodeAt(0));
    return { earlyData: arryBuffer.buffer, error: null };
  } catch (error) {
    log.error(logContext, 'base64ToArrayBuffer:ERROR', 'Error in base64ToArrayBuffer', error);
    return { earlyData: null, error }; // Return the error if decoding fails.
  }
}

/**
 * Checks if a given string is a valid UUID (v4).
 *
 * @param {string} uuid - The string to check.
 * @returns {boolean} True if the string is a valid UUID, false otherwise.
 */
export function isValidUUID(uuid) {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

/**
 * Converts a Uint8Array (or a portion of it) to a UUID string.
 *
 * @param {Uint8Array} arr - The Uint8Array.
 * @param {number} [offset=0] - The offset within the array to start from.
 * @returns {string} The UUID string.
 * @throws {TypeError} If the resulting UUID string is invalid.
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
    throw TypeError('Stringified UUID is invalid');
  }
  return uuid;
}
