// =================================================================
// File: handler/http.js
// Description: Handles all standard HTTP (non-WebSocket) requests.
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
 * Main HTTP request handler.
 * Routes requests to the /info endpoint for diagnostics, or returns a masquerading 404 page.
 *
 * @param {Request} request - The incoming HTTP request.
 * @param {object} env - Environment variables from Cloudflare Workers runtime.
 * @param {object} config - The request-scoped configuration.
 * @returns {Promise<Response>} The HTTP response.
 */
export async function handleHttpRequest(request, env, config) {
  const url = new URL(request.url);

  // Route to info endpoint if requested
  if (url.pathname.endsWith('/info')) {
    return handleInfoRequest(request, env, config);
  }

  // Return masquerade 404 for all other paths
  logger.info('HTTP:MASQUERADE', 'Returning 404 Not Found page');
  return new Response(MASQUERADE_RESPONSE, {
    status: 404,
    headers: { 'Content-Type': 'text/html' },
  });
}

// === Private Helper Functions ===

/**
 * Handles requests to the "/info" endpoint.
 * Provides diagnostic information about the request and configuration.
 * Requires Basic Authentication using the configured password.
 *
 * @param {Request} request - The incoming HTTP request.
 * @param {object} env - Environment variables from Cloudflare Workers runtime.
 * @param {object} config - The request-scoped configuration.
 * @returns {Response} JSON response with diagnostic information or 401 Unauthorized.
 */
function handleInfoRequest(request, env, config) {
  // === Authenticate Request ===
  const authHeader = request.headers.get('Authorization');
  const expectedAuth = `Basic ${btoa(':' + config.PASSWORD)}`;

  if (authHeader !== expectedAuth) {
    logger.warn('HTTP:AUTH', 'Unauthorized access attempt to /info endpoint');
    return new Response('Unauthorized', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="VLESS Worker Info"' },
    });
  }

  // === Build Diagnostic Information ===
  const diagnosticInfo = {
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

  // === Return JSON Response ===
  return new Response(JSON.stringify(diagnosticInfo, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
