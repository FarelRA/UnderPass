// =================================================================
// File: lib/config.js
// Description: Centralized configuration management.
// =================================================================

// Default configuration settings. These can be overridden by environment variables or URL parameters.
export let config = {
  USER_ID: '86c50e3a-5b87-49dd-bd20-03c7f2735e40', // Your VLESS UUID
  PASSWORD: 'password', // Password for the /info endpoint. *CHANGE IN PRODUCTION*.
  RELAY_ADDR: 'bpb.yousef.isegaro.com:443', // Relay address for the retry mechanism.
  DOH_URL: 'https://cloudflare-dns.com/dns-query', // DNS-over-HTTPS resolver.
  LOG_LEVEL: 'INFO', // 'DEBUG', 'INFO', 'WARN', 'ERROR'.
};

// Pre-calculated byte-to-hexadecimal mappings for efficient UUID stringification.
export const byteToHex = Array.from({ length: 256 }, (v, i) => i.toString(16).padStart(2, '0'));

/**
 * Retrieves and updates the configuration from environment variables and URL
 * parameters. Environment variables take precedence over defaults, and URL
 * parameters take precedence over environment variables.
 * @param {URL} url - The request URL.
 * @param {object} env - The environment variables from the Cloudflare Worker runtime.
 */
export function initializeConfig(url, env) {
  config.USER_ID = env.USER_ID || config.USER_ID;
  config.RELAY_ADDR = env.RELAY_ADDR || config.RELAY_ADDR;
  config.DOH_URL = env.DOH_URL || config.DOH_URL;
  config.PASSWORD = env.PASSWORD || config.PASSWORD;
  config.LOG_LEVEL = env.LOG_LEVEL || config.LOG_LEVEL;

  // Override with URL parameters.
  config.RELAY_ADDR = url.searchParams.get('relay') || config.RELAY_ADDR;
  config.DOH_URL = url.searchParams.get('doh') || config.DOH_URL;
  config.LOG_LEVEL = url.searchParams.get('log') || config.LOG_LEVEL;
}
