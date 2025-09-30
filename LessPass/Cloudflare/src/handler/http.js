// =================================================================
// File: handler/http.js
// Description: Handles all standard HTTP (non-WebSocket) requests.
// =================================================================

import { logger } from './lib/logger.js';
import { config } from './lib/config.js';

/**
 * Handles requests to the "/info" endpoint, providing diagnostic information.
 * Requires Basic Authentication.
 */
function handleInfoRequest(request, env, url, logContext) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || authHeader !== `Basic ${btoa(':' + config.PASSWORD)}`) {
    logger.warn(logContext, 'HTTP:AUTH_FAIL', 'Unauthorized access attempt to /info.');
    return new Response('Unauthorized', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="VLESS Worker Info"' },
    });
  }

  const info = {
    status: 'OK',
    config: {
      USER_ID: config.USER_ID,
      RELAY_ADDR: config.RELAY_ADDR,
      DOH_URL: config.DOH_URL,
      LOG_LEVEL: config.LOG_LEVEL,
      PASSWORD: config.PASSWORD,
    },
    request: {
      method: request.method,
      url: request.url,
      headers: Object.fromEntries(request.headers.entries()),
      cf: request.cf,
    },
    env: {
      USER_ID: env.USER_ID,
      RELAY_ADDR: env.RELAY_ADDR,
      DOH_URL: env.DOH_URL,
      PASSWORD: env.PASSWORD,
      LOG_LEVEL: env.LOG_LEVEL,
    },
  };

  return new Response(JSON.stringify(info, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Main HTTP request handler. Routes to the info endpoint or returns a
 * masquerading 404 page.
 */
export async function handleHttpRequest(request, env, logContext) {
  const url = new URL(request.url);
  const httpLogContext = { ...logContext, section: 'HTTP' };

  if (url.pathname.endsWith('/info')) {
    return handleInfoRequest(request, env, url, httpLogContext);
  }

  logger.info(httpLogContext, 'MASQUERADE', 'Returning 404 Not Found (masquerade).');
  return new Response(
    '<!DOCTYPE html><html><head><title>404 Not Found</title></head><body><center><h1>404 Not Found</h1></center><hr><center>nginx</center></body></html>',
    { status: 404, headers: { 'Content-Type': 'text/html' } }
  );
}
