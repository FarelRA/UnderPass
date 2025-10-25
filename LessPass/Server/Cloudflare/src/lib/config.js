// =================================================================
// File: lib/config.js
// Description: Centralized configuration management for the VLESS worker.
//              Handles configuration priority: URL params > env vars > defaults.
//              Defines VLESS protocol constants and lookup tables.
// =================================================================

// === Default Configuration ===

/**
 * Default configuration settings.
 * These values are used when environment variables or URL parameters are not provided.
 * 
 * SECURITY NOTE: Change USER_ID and PASSWORD in production!
 */
const defaultConfig = {
  USER_ID: '86c50e3a-5b87-49dd-bd20-03c7f2735e40', // VLESS UUID for authentication (CHANGE IN PRODUCTION)
  PASSWORD: 'password', // Password for /info endpoint (CHANGE IN PRODUCTION)
  RELAY_ADDR: 'bpb.yousef.isegaro.com:443', // Relay address for retry mechanism
  DOH_URL: 'https://cloudflare-dns.com/dns-query', // DNS-over-HTTPS resolver
  LOG_LEVEL: 'INFO', // Logging verbosity: ERROR, WARN, INFO, DEBUG, TRACE
};

// === Configuration Initialization ===

/**
 * Creates a final configuration object for a single request.
 * Merges defaults, environment variables, and URL parameters with the following priority:
 * 1. URL query parameters (highest priority)
 * 2. Environment variables
 * 3. Default values (lowest priority)
 *
 * @param {URL} url - The parsed request URL.
 * @param {object} env - Environment variables from Cloudflare Workers runtime.
 * @returns {object} A finalized, request-scoped configuration object.
 *
 * @example
 * // URL: https://worker.example.com/?log=DEBUG&relay=custom.relay.com:8443
 * const config = initializeConfig(url, env);
 * // config.LOG_LEVEL = 'DEBUG' (from URL)
 * // config.RELAY_ADDR = 'custom.relay.com:8443' (from URL)
 */
export function initializeConfig(url, env) {
  return {
    USER_ID: env.USER_ID || defaultConfig.USER_ID,
    PASSWORD: env.PASSWORD || defaultConfig.PASSWORD,
    RELAY_ADDR: url.searchParams.get('relay') || env.RELAY_ADDR || defaultConfig.RELAY_ADDR,
    DOH_URL: url.searchParams.get('doh') || env.DOH_URL || defaultConfig.DOH_URL,
    LOG_LEVEL: url.searchParams.get('log') || env.LOG_LEVEL || defaultConfig.LOG_LEVEL,
  };
}

// === VLESS Protocol Constants ===

/**
 * VLESS protocol constants.
 * Based on the VLESS protocol specification.
 *
 * @see https://github.com/v2fly/v2ray-core/blob/master/proxy/vless/protocol/protocol.go
 */
export const VLESS = {
  // Header length constants
  MIN_HEADER_LENGTH: 24, // Minimum bytes required for a valid VLESS header
  VERSION_LENGTH: 1, // VLESS version field length (1 byte)
  USERID_LENGTH: 16, // User ID (UUID) length (16 bytes)

  // Command types
  COMMAND: {
    TCP: 1, // TCP proxy command
    UDP: 2, // UDP proxy command
  },

  // Address types
  ADDRESS_TYPE: {
    IPV4: 1, // IPv4 address (4 bytes)
    FQDN: 2, // Fully Qualified Domain Name (variable length)
    IPV6: 3, // IPv6 address (16 bytes)
  },
};

// === WebSocket Constants ===

/**
 * WebSocket ready state constants.
 * Used for checking connection status before operations.
 * 
 * @see https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/readyState
 */
export const WS_READY_STATE = {
  CONNECTING: 0, // Connection is being established
  OPEN: 1, // Connection is open and ready
  CLOSING: 2, // Connection is closing
  CLOSED: 3, // Connection is closed
};

// === Lookup Tables ===

/**
 * Pre-computed byte-to-hexadecimal string mappings.
 * Used for efficient UUID stringification without runtime conversion.
 * 
 * Performance: ~3-5x faster than toString(16).padStart(2, '0')
 *
 * @type {string[]} Array of 256 hex strings ('00' to 'ff')
 */
export const byteToHex = [
  '00','01','02','03','04','05','06','07','08','09','0a','0b','0c','0d','0e','0f',
  '10','11','12','13','14','15','16','17','18','19','1a','1b','1c','1d','1e','1f',
  '20','21','22','23','24','25','26','27','28','29','2a','2b','2c','2d','2e','2f',
  '30','31','32','33','34','35','36','37','38','39','3a','3b','3c','3d','3e','3f',
  '40','41','42','43','44','45','46','47','48','49','4a','4b','4c','4d','4e','4f',
  '50','51','52','53','54','55','56','57','58','59','5a','5b','5c','5d','5e','5f',
  '60','61','62','63','64','65','66','67','68','69','6a','6b','6c','6d','6e','6f',
  '70','71','72','73','74','75','76','77','78','79','7a','7b','7c','7d','7e','7f',
  '80','81','82','83','84','85','86','87','88','89','8a','8b','8c','8d','8e','8f',
  '90','91','92','93','94','95','96','97','98','99','9a','9b','9c','9d','9e','9f',
  'a0','a1','a2','a3','a4','a5','a6','a7','a8','a9','aa','ab','ac','ad','ae','af',
  'b0','b1','b2','b3','b4','b5','b6','b7','b8','b9','ba','bb','bc','bd','be','bf',
  'c0','c1','c2','c3','c4','c5','c6','c7','c8','c9','ca','cb','cc','cd','ce','cf',
  'd0','d1','d2','d3','d4','d5','d6','d7','d8','d9','da','db','dc','dd','de','df',
  'e0','e1','e2','e3','e4','e5','e6','e7','e8','e9','ea','eb','ec','ed','ee','ef',
  'f0','f1','f2','f3','f4','f5','f6','f7','f8','f9','fa','fb','fc','fd','fe','ff',
];
