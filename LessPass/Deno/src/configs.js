// configs.js
export let CONFIG = {
    USER_ID: '86c50e3a-5b87-49dd-bd20-03c7f2735e40', // Default UUID
    PASSWORD: 'password',                            // Default password, CHANGE IN PRODUCTION
    DOH_URL: 'https://cloudflare-dns.com/dns-query', // Default DNS-over-HTTPS
    LOG_LEVEL: 'INFO',                               // Default log level
};

// WebSocket ready state constants
export const WS_READY_STATE_OPEN = 1;
export const WS_READY_STATE_CLOSING = 2;

// Pre-calculated byte-to-hexadecimal mappings for UUID stringification
export const byteToHex = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

/**
 * Retrieves and updates the configuration from environment variables.
 * @returns {object} The updated configuration object.
 */
export function getConfig() {
    CONFIG.USER_ID = Deno.env.get('USER_ID') || CONFIG.USER_ID;
    CONFIG.DOH_URL = Deno.env.get('DOH_URL') || CONFIG.DOH_URL;
    CONFIG.PASSWORD = Deno.env.get('PASSWORD') || CONFIG.PASSWORD;
    CONFIG.LOG_LEVEL = Deno.env.get('LOG_LEVEL') || CONFIG.LOG_LEVEL;
    return CONFIG;
}
