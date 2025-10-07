// =================================================================
// File: handler/http.js
// Description: Handles all standard HTTP (non-WebSocket) requests.
// =================================================================

import { logger } from '../lib/logger.js';

const MASQUERADE_RESPONSE = `<!DOCTYPE html><html><head><title>404 Not Found</title></head><body><center><h1>404 Not Found</h1></center><hr><center>nginx</center></body></html>`;

/**
 * Main HTTP request handler. Routes to the info endpoint or returns a
 * masquerading 404 page for all other paths.
 * @param {Request} request The incoming request.
 * @param {object} env The environment variables.
 * @param {object} config The request-scoped configuration.
 * @param {object} logContext Logging context.
 * @returns {Promise<Response>}
 */
export async function handleHttpRequest(request, env, config) {
  

  try {
    if (!request || !request.url) {
      logger.error('INVALID_REQUEST', 'Request or request.url is null/undefined');
      return new Response('Bad Request', { status: 400 });
    }

    if (!config) {
      logger.error('INVALID_CONFIG', 'Config is null/undefined');
      return new Response('Internal Server Error', { status: 500 });
    }

    let url;
    try {
      url = new URL(request.url);
    } catch (urlError) {
      logger.error('URL_PARSE_ERROR', `Failed to parse URL: ${urlError.message}`);
      return new Response('Bad Request: Invalid URL', { status: 400 });
    }

    if (url.pathname.endsWith('/info')) {
      try {
        return handleInfoRequest(request, config);
      } catch (infoError) {
        logger.error('INFO_HANDLER_ERROR', `Info handler failed: ${infoError.message}`);
        return new Response('Internal Server Error', { status: 500 });
      }
    }

    logger.info('MASQUERADE', 'Returning 404 Not Found.');
    return new Response(MASQUERADE_RESPONSE, { status: 404, headers: { 'Content-Type': 'text/html' } });
  } catch (error) {
    logger.error('HTTP_HANDLER_ERROR', `Unhandled error in handleHttpRequest: ${error.message}`);
    return new Response('Internal Server Error', { status: 500 });
  }
}

/**
 * Handles requests to the "/info" endpoint, providing diagnostic information.
 * Requires Basic Authentication using the configured password.
 * @param {Request} request The incoming request.
 * @param {object} config The request-scoped configuration.
 * @param {object} logContext Logging context.
 * @returns {Response}
 */
function handleInfoRequest(request, config) {
  if (!request) {
    throw new Error('Request is null/undefined');
  }

  if (!config || !config.PASSWORD) {
    throw new Error('Config or PASSWORD is null/undefined');
  }

  let authHeader;
  try {
    authHeader = request.headers.get('Authorization');
  } catch (headerError) {
    logger.error('AUTH_HEADER_ERROR', `Failed to get Authorization header: ${headerError.message}`);
    return new Response('Unauthorized', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="VLESS Worker Info"' },
    });
  }

  let expectedAuth;
  try {
    expectedAuth = `Basic ${btoa(':' + config.PASSWORD)}`;
  } catch (btoaError) {
    logger.error('BTOA_ERROR', `Failed to encode password: ${btoaError.message}`);
    return new Response('Internal Server Error', { status: 500 });
  }
  
  if (authHeader !== expectedAuth) {
    logger.warn('HTTP:AUTH_FAIL', 'Unauthorized access attempt to /info.');
    return new Response('Unauthorized', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="VLESS Worker Info"' },
    });
  }

  let info;
  try {
    info = {
      status: 'OK',
      request: {
        method: request.method,
        url: request.url,
        headers: Object.fromEntries(request.headers.entries()),
        cf: request.cf,
      },
      config,
    };
  } catch (infoError) {
    logger.error('INFO_BUILD_ERROR', `Failed to build info object: ${infoError.message}`);
    return new Response('Internal Server Error', { status: 500 });
  }

  let jsonResponse;
  try {
    jsonResponse = JSON.stringify(info, null, 2);
  } catch (jsonError) {
    logger.error('JSON_STRINGIFY_ERROR', `Failed to stringify info: ${jsonError.message}`);
    return new Response('Internal Server Error', { status: 500 });
  }

  return new Response(jsonResponse, {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
