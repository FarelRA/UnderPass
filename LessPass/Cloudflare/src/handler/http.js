// =================================================================
// File: handler/http.js
// Description: Handles all standard HTTP (non-WebSocket) requests.
// =================================================================

import { logger } from '../lib/logger.js';

/**
 * Handles requests to the "/info" endpoint, providing diagnostic information.
 * Requires Basic Authentication using the configured password.
 * @param {Request} request The incoming request.
 * @param {object} env The environment variables.
 * @param {object} config The request-scoped configuration.
 * @param {object} logContext Logging context.
 * @returns {Response}
 */
function handleInfoRequest(request, env, config, logContext) {
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
    request: {
      method: request.method,
      url: request.url,
      headers: Object.fromEntries(request.headers.entries()),
      cf: request.cf,
    },
    config,
    env,
  };

  return new Response(JSON.stringify(info, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Main HTTP request handler. Routes to the info endpoint or returns a
 * masquerading 404 page for all other paths.
 * @param {Request} request The incoming request.
 * @param {object} env The environment variables.
 * @param {object} config The request-scoped configuration.
 * @param {object} logContext Logging context.
 * @returns {Promise<Response>}
 */
export async function handleHttpRequest(request, env, config, logContext) {
  const url = new URL(request.url);
  const httpLogContext = { ...logContext, section: 'HTTP' };

  if (url.pathname.endsWith('/info')) {
    return handleInfoRequest(request, env, config, httpLogContext);
  }

  logger.info(httpLogContext, 'MASQUERADE', 'Returning 404 Not Found.');
  return new Response(
    `<!DOCTYPE html><html><head><title>404 Not Found</title></head><body><center><h1>404 Not Found</h1></center><hr><center>nginx</center></body></html>`,
    { status: 404, headers: { 'Content-Type': 'text/html' } }
  );
}
