// =================================================================
// File: lib/config.js
// Description: Centralized configuration management.
// =================================================================

import { logger } from './logger.js';

// Default configuration settings.
const defaultConfig = {
  USER_ID: '86c50e3a-5b87-49dd-bd20-03c7f2735e40', // Your VLESS UUID
  PASSWORD: 'password', // Password for the /info endpoint. *CHANGE IN PRODUCTION*.
  RELAY_ADDR: 'bpb.yousef.isegaro.com:443', // Relay address for the retry mechanism.
  DOH_URL: 'https://cloudflare-dns.com/dns-query', // DNS-over-HTTPS resolver.
  LOG_LEVEL: 'INFO', // 'DEBUG', 'INFO', 'WARN', 'ERROR'.
};

/**
 * Creates a final configuration object for a single request by merging defaults,
 * environment variables, and URL parameters.
 * @param {URL} url The request URL.
 * @param {object} env The environment variables from the Cloudflare Worker runtime.
 * @returns {object} A finalized, request-scoped configuration object.
 */
export function initializeConfig(url, env) {
  logger.trace('CONFIG', 'initializeConfig called');

  if (!url) {
    logger.error('CONFIG', 'URL parameter is null/undefined');
    throw new Error('URL parameter is required for config initialization');
  }

  if (!env || typeof env !== 'object') {
    logger.error('CONFIG', 'Environment object is invalid');
    throw new Error('Environment object is required for config initialization');
  }

  logger.debug('CONFIG', 'Validating environment variables');

  try {
    const config = {
      USER_ID: env.USER_ID || defaultConfig.USER_ID,
      PASSWORD: env.PASSWORD || defaultConfig.PASSWORD,
      RELAY_ADDR: url.searchParams.get('relay') || env.RELAY_ADDR || defaultConfig.RELAY_ADDR,
      DOH_URL: url.searchParams.get('doh') || env.DOH_URL || defaultConfig.DOH_URL,
      LOG_LEVEL: url.searchParams.get('log') || env.LOG_LEVEL || defaultConfig.LOG_LEVEL,
    };

    logger.trace('CONFIG', `USER_ID source: ${env.USER_ID ? 'env' : 'default'}`);
    logger.trace('CONFIG', `PASSWORD source: ${env.PASSWORD ? 'env' : 'default'}`);
    logger.trace('CONFIG', `RELAY_ADDR source: ${url.searchParams.get('relay') ? 'url' : env.RELAY_ADDR ? 'env' : 'default'}`);
    logger.trace('CONFIG', `DOH_URL source: ${url.searchParams.get('doh') ? 'url' : env.DOH_URL ? 'env' : 'default'}`);
    logger.trace('CONFIG', `LOG_LEVEL source: ${url.searchParams.get('log') ? 'url' : env.LOG_LEVEL ? 'env' : 'default'}`);

    if (!config.USER_ID || typeof config.USER_ID !== 'string') {
      logger.error('CONFIG', 'USER_ID validation failed');
      throw new Error('USER_ID must be a non-empty string');
    }

    if (!config.RELAY_ADDR || typeof config.RELAY_ADDR !== 'string') {
      logger.error('CONFIG', 'RELAY_ADDR validation failed');
      throw new Error('RELAY_ADDR must be a non-empty string');
    }

    if (!config.DOH_URL || typeof config.DOH_URL !== 'string') {
      logger.error('CONFIG', 'DOH_URL validation failed');
      throw new Error('DOH_URL must be a non-empty string');
    }

    logger.debug('CONFIG', `Configuration initialized successfully with LOG_LEVEL=${config.LOG_LEVEL}`);
    return config;
  } catch (error) {
    logger.error('CONFIG', `Config initialization failed: ${error.message}`);
    throw new Error(`Config initialization failed: ${error.message}`);
  }
}

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

/** Pre-calculate byte-to-hexadecimal mappings for efficient UUID stringification. */
export const byteToHex = [
  '00',
  '01',
  '02',
  '03',
  '04',
  '05',
  '06',
  '07',
  '08',
  '09',
  '0a',
  '0b',
  '0c',
  '0d',
  '0e',
  '0f',
  '10',
  '11',
  '12',
  '13',
  '14',
  '15',
  '16',
  '17',
  '18',
  '19',
  '1a',
  '1b',
  '1c',
  '1d',
  '1e',
  '1f',
  '20',
  '21',
  '22',
  '23',
  '24',
  '25',
  '26',
  '27',
  '28',
  '29',
  '2a',
  '2b',
  '2c',
  '2d',
  '2e',
  '2f',
  '30',
  '31',
  '32',
  '33',
  '34',
  '35',
  '36',
  '37',
  '38',
  '39',
  '3a',
  '3b',
  '3c',
  '3d',
  '3e',
  '3f',
  '40',
  '41',
  '42',
  '43',
  '44',
  '45',
  '46',
  '47',
  '48',
  '49',
  '4a',
  '4b',
  '4c',
  '4d',
  '4e',
  '4f',
  '50',
  '51',
  '52',
  '53',
  '54',
  '55',
  '56',
  '57',
  '58',
  '59',
  '5a',
  '5b',
  '5c',
  '5d',
  '5e',
  '5f',
  '60',
  '61',
  '62',
  '63',
  '64',
  '65',
  '66',
  '67',
  '68',
  '69',
  '6a',
  '6b',
  '6c',
  '6d',
  '6e',
  '6f',
  '70',
  '71',
  '72',
  '73',
  '74',
  '75',
  '76',
  '77',
  '78',
  '79',
  '7a',
  '7b',
  '7c',
  '7d',
  '7e',
  '7f',
  '80',
  '81',
  '82',
  '83',
  '84',
  '85',
  '86',
  '87',
  '88',
  '89',
  '8a',
  '8b',
  '8c',
  '8d',
  '8e',
  '8f',
  '90',
  '91',
  '92',
  '93',
  '94',
  '95',
  '96',
  '97',
  '98',
  '99',
  '9a',
  '9b',
  '9c',
  '9d',
  '9e',
  '9f',
  'a0',
  'a1',
  'a2',
  'a3',
  'a4',
  'a5',
  'a6',
  'a7',
  'a8',
  'a9',
  'aa',
  'ab',
  'ac',
  'ad',
  'ae',
  'af',
  'b0',
  'b1',
  'b2',
  'b3',
  'b4',
  'b5',
  'b6',
  'b7',
  'b8',
  'b9',
  'ba',
  'bb',
  'bc',
  'bd',
  'be',
  'bf',
  'c0',
  'c1',
  'c2',
  'c3',
  'c4',
  'c5',
  'c6',
  'c7',
  'c8',
  'c9',
  'ca',
  'cb',
  'cc',
  'cd',
  'ce',
  'cf',
  'd0',
  'd1',
  'd2',
  'd3',
  'd4',
  'd5',
  'd6',
  'd7',
  'd8',
  'd9',
  'da',
  'db',
  'dc',
  'dd',
  'de',
  'df',
  'e0',
  'e1',
  'e2',
  'e3',
  'e4',
  'e5',
  'e6',
  'e7',
  'e8',
  'e9',
  'ea',
  'eb',
  'ec',
  'ed',
  'ee',
  'ef',
  'f0',
  'f1',
  'f2',
  'f3',
  'f4',
  'f5',
  'f6',
  'f7',
  'f8',
  'f9',
  'fa',
  'fb',
  'fc',
  'fd',
  'fe',
  'ff',
];
