// =================================================================
// File: handler/http.js
// Description: Handles all standard HTTP (non-WebSocket) requests.
//              Provides /info diagnostic endpoint and masquerades as nginx
//              for all other paths to hide the service's true nature.
// =================================================================

import { logger } from '../lib/logger.js';

// === Constants ===

/**
 * Masquerade response to mimic nginx 404 page.
 * Used to hide the true nature of the service from casual probing.
 */
const MASQUERADE_RESPONSE = `<!DOCTYPE html><html><head><title>404 Not Found</title></head><body><center><h1>404 Not Found</h1></center><hr><center>nginx</center></body></html>`;

// === Public API ===

/**
 * Handles HTTP requests.
 * Routes requests to the /info endpoint for diagnostics, or returns a masquerading 404 page.
 *
 * @param {Request} request - The incoming HTTP request.
 * @param {object} env - Environment variables from Cloudflare Workers runtime.
 * @param {object} config - The request-scoped configuration.
 * @returns {Promise<Response>} The HTTP response.
 */
export async function handleHttp(request, env, config) {
  const url = new URL(request.url);
  logger.debug('HTTP:HANDLER', `Processing HTTP request: ${request.method} ${url.pathname}`);

  // Route to info endpoint if requested
  if (url.pathname.endsWith('/info')) {
    logger.info('HTTP:ROUTE', 'Routing to /info diagnostic endpoint');
    return processInfo(request, env, config);
  }

  // Return masquerade 404 for all other paths
  logger.info('HTTP:MASQUERADE', `Returning masquerade 404 for path: ${url.pathname}`);
  return new Response(MASQUERADE_RESPONSE, {
    status: 404,
    headers: { 'Content-Type': 'text/html' },
  });
}

// === Private Helper Functions ===

/**
 * Processes requests to the "/info" endpoint.
 * Provides diagnostic information about the request and configuration.
 * Requires Basic Authentication using the configured password.
 *
 * @param {Request} request - The incoming HTTP request.
 * @param {object} env - Environment variables from Cloudflare Workers runtime.
 * @param {object} config - The request-scoped configuration.
 * @returns {Response} JSON response with diagnostic information or 401 Unauthorized.
 */
function processInfo(request, env, config) {
  logger.debug('HTTP:INFO', 'Processing /info endpoint request');

  // Authenticate request using Basic Auth
  const authHeader = request.headers.get('Authorization');
  logger.trace('HTTP:AUTH', `Authorization header present: ${!!authHeader}`);
  
  const expectedAuth = `Basic ${btoa(':' + config.PASSWORD)}`;

  if (authHeader !== expectedAuth) {
    logger.warn('HTTP:AUTH', 'Unauthorized access attempt to /info endpoint');
    logger.trace('HTTP:AUTH', `Expected: ${expectedAuth.substring(0, 20)}..., Got: ${authHeader?.substring(0, 20) || 'none'}...`);
    return new Response('Unauthorized', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="VLESS Worker Info"' },
    });
  }

  logger.info('HTTP:AUTH', 'Authentication successful for /info endpoint');

  // Build diagnostic information
  logger.debug('HTTP:INFO', 'Building diagnostic information');
  const info = {
    status: 'Ok',
    request: {
      method: request.method,
      url: request.url,
      headers: Object.fromEntries(request.headers.entries()),
      cf: request.cf,
    },
    env,
    config,
  };

  logger.trace('HTTP:INFO', `Diagnostic info size: ${JSON.stringify(info).length} bytes`);
  logger.info('HTTP:INFO', 'Returning diagnostic information');

  // Return JSON response
  return new Response(JSON.stringify(info, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
