// =================================================================
// File: lib/config.js
// Description: Centralized configuration management.
// =================================================================

// Default configuration settings.
const defaultConfig = {
  USER_ID: '86c50e3a-5b87-49dd-bd20-03c7f2735e40', // Your VLESS UUID
  PASSWORD: 'password', // Password for the /info endpoint. *CHANGE IN PRODUCTION*.
  RELAY_ADDR: 'bpb.yousef.isegaro.com:443', // Relay address for the retry mechanism.
  DOH_URL: 'https://cloudflare-dns.com/dns-query', // DNS-over-HTTPS resolver.
  LOG_LEVEL: 'INFO', // 'DEBUG', 'INFO', 'WARN', 'ERROR'.
};

/**
 * VLESS protocol constants.
 * @see https://github.com/v2fly/v2ray-core/blob/master/proxy/vless/protocol/protocol.go
 */
export const VLESS = {
  MIN_HEADER_LENGTH: 24,
  VERSION_LENGTH: 1,
  USERID_LENGTH: 16,
  COMMAND: { TCP: 1, UDP: 2 },
  ADDRESS_TYPE: { IPV4: 1, FQDN: 2, IPV6: 3 },
};

/** WebSocket ready state constants for checking connection status. */
export const WS_READY_STATE = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 };

/** Pre-calculated byte-to-hexadecimal mappings for efficient UUID stringification. */
export const byteToHex = Array.from({ length: 256 }, (v, i) => i.toString(16).padStart(2, '0'));

/**
 * Creates a final configuration object for a single request by merging defaults,
 * environment variables, and URL parameters.
 * @param {URL} url The request URL.
 * @param {object} env The environment variables from the Cloudflare Worker runtime.
 * @returns {object} A finalized, request-scoped configuration object.
 */
export function initializeConfig(url, env) {
  return {
    // Start with defaults
    ...defaultConfig,
    // Override with environment variables
    USER_ID: env.USER_ID || defaultConfig.USER_ID,
    RELAY_ADDR: env.RELAY_ADDR || defaultConfig.RELAY_ADDR,
    DOH_URL: env.DOH_URL || defaultConfig.DOH_URL,
    PASSWORD: env.PASSWORD || defaultConfig.PASSWORD,
    LOG_LEVEL: env.LOG_LEVEL || defaultConfig.LOG_LEVEL,
    // Override with URL parameters
    RELAY_ADDR: url.searchParams.get('relay') || env.RELAY_ADDR || defaultConfig.RELAY_ADDR,
    DOH_URL: url.searchParams.get('doh') || env.DOH_URL || defaultConfig.DOH_URL,
    LOG_LEVEL: url.searchParams.get('log') || env.LOG_LEVEL || defaultConfig.LOG_LEVEL,
  };
}
