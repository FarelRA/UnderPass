// utils.js
import { WS_READY_STATE_CLOSING, WS_READY_STATE_OPEN, byteToHex } from './configs.js';
import { log } from './logs.js';

/**
 * Safely closes a WebSocket.
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
 * Creates a ReadableStream from a WebSocket.
 * @param {WebSocket} webSocket - The WebSocket.
 * @param {string} earlyDataHeader - The base64-encoded early data header.
 * @param {object} baseLogContext - The base logging context.
 * @returns {ReadableStream} A ReadableStream representing the WebSocket data.
 */
export function makeReadableWebSocketStream(webSocket, earlyDataHeader, baseLogContext) {
    let readableStreamCancel = false;
    const logContext = { ...baseLogContext, section: 'UTILS' };
    const stream = new ReadableStream({
        start(controller) {
            webSocket.onmessage = (event) => {
                if (readableStreamCancel) return;
                controller.enqueue(event.data);
            };

            webSocket.onclose = () => {
                if (readableStreamCancel) return;
                controller.close();
            };

            webSocket.onerror = (err) => {
                log.error(logContext, 'makeReadableWebSocketStream:ERROR', 'WebSocket error:', err);
                controller.error(err);
            };

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
    return stream;
}

/**
 * Processes the VLESS protocol header from a buffer.
 * @param {ArrayBuffer} streamBuffer - The buffer containing the protocol header.
 * @param {string} userID - The expected user ID.
 * @returns {object} An object containing the extracted information, or an error.
 */
export function processStreamHeader(streamBuffer, userID) {
    if (streamBuffer.byteLength < 24) {
        return { hasError: true, message: 'Invalid data: insufficient length.' };
    }

    const version = new Uint8Array(streamBuffer.slice(0, 1));
    const userIdBuffer = new Uint8Array(streamBuffer.slice(1, 17));

    if (stringifyUUID(userIdBuffer) !== userID) {
        return { hasError: true, message: 'Invalid user ID.' };
    }

    const optLength = new Uint8Array(streamBuffer.slice(17, 18))[0];
    const command = new Uint8Array(streamBuffer.slice(18 + optLength, 18 + optLength + 1))[0];
    let isUDP = false;
    if (command === 2) { // 0x02 for UDP
        isUDP = true;
    } else if (command !== 1) { // 0x01 for TCP
        return { hasError: true, message: `Unsupported command: ${command}.` };
    }

    const portIndex = 18 + optLength + 1;
    const portBuffer = streamBuffer.slice(portIndex, portIndex + 2);
    const portRemote = new DataView(portBuffer).getUint16(0);

    let addressIndex = portIndex + 2;
    const addressType = new Uint8Array(streamBuffer.slice(addressIndex, addressIndex + 1))[0];
    let addressLength = 0;
    let addressValueIndex = addressIndex + 1;
    let addressValue = '';

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
            addressValue = `[${ipv6.join(':')}]`;
            break;
        default:
            return { hasError: true, message: `Invalid address type: ${addressType}.` };
    }

    if (!addressValue) {
        return { hasError: true, message: 'Address value is empty.' };
    }

    return {
        hasError: false,
        addressRemote: addressValue,
        portRemote,
        rawDataIndex: addressValueIndex + addressLength,
        streamVersion: version,
        isUDP,
    };
}

/**
 * Decodes a base64 string to an ArrayBuffer.
 * @param {string} base64Str - The base64-encoded string.
 * @param {object} baseLogContext - The logging context.
 * @returns {object} An object with the decoded data or an error.
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
        log.error(logContext, 'base64ToArrayBuffer:ERROR', 'Base64 decoding error:', error);
        return { earlyData: null, error };
    }
}

/**
 * Checks if a given string is a valid UUID.
 * @param {string} uuid - The string to check.
 * @returns {boolean} True if valid.
 */
export function isValidUUID(uuid) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(uuid);
}

/**
 * Converts a Uint8Array to a UUID string.
 * @param {Uint8Array} arr - The Uint8Array.
 * @param {number} [offset=0] - The offset to start from.
 * @returns {string} The UUID string.
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
        throw new TypeError('Stringified UUID is invalid: ' + uuid);
    }
    return uuid;
}
