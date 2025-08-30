/**
 * Cloudflare Worker: Permissive CORS Proxy (Refactored)
 *
 * How it works:
 * 1. Intercepts requests to the worker URL.
 * 2. Expects the target API endpoint in the `?url=` query parameter.
 * 3. Validates the target URL (must be http/https).
 * 4. Handles OPTIONS (preflight) requests by returning permissive CORS headers.
 * 5. Forwards other requests (GET, POST, etc.) to the target URL, cleaning sensitive headers.
 * 6. Takes the response from the target URL and adds permissive CORS headers before returning it to the client.
 *
 * Usage: https://worker.domain.com/?url=https://target-api.com/data
 */

// Headers to remove from the incoming request before forwarding
const HEADERS_TO_STRIP = [
  'cf-connecting-ip',
  'cf-ipcountry',
  'cf-ray',
  'cf-visitor',
  'cf-worker',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'host',      // Let fetch() set the correct Host based on targetUrl
  'origin',    // Avoid sending browser origin to target
  'referer',   // Avoid sending worker's referer
];

export default {
  /**
   * Main fetch handler for the Cloudflare Worker.
   * @param {Request} request - The incoming request.
   * @param {object} env - Environment variables (if any).
   * @param {ExecutionContext} ctx - Execution context.
   * @returns {Promise<Response>} The response to send back to the client.
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const targetUrlParam = url.searchParams.get('url');

    // 1. Validate presence of "url" query parameter
    if (!targetUrlParam) {
      return createJsonResponse({ error: 'Missing "url" query parameter.' }, 400);
    }

    // 2. Validate target URL structure and protocol
    let targetUrl;
    try {
      targetUrl = new URL(targetUrlParam);
    } catch (e) {
      return createJsonResponse({ error: `Invalid target URL provided: "${targetUrlParam}"` }, 400);
    }

    // 3. Handle based on request method
    if (request.method === 'OPTIONS') {
      return handleOptions(request);
    } else {
      return handleProxyRequest(request, targetUrl);
    }
  }
};

/**
 * Handles OPTIONS (preflight) requests.
 * @param {Request} request - The incoming OPTIONS request.
 * @returns {Response} A response with permissive CORS headers.
 */
function handleOptions(request) {
  const requestOrigin = request.headers.get('Origin');
  const corsHeaders = createCorsHeaders(requestOrigin);

  return new Response(null, {
    status: 204, // No Content
    headers: corsHeaders,
  });
}

/**
 * Handles actual data requests (GET, POST, etc.).
 * Forwards the request to the target URL and adds CORS headers to the response.
 * @param {Request} request - The incoming request.
 * @param {URL} targetUrl - The validated target URL object.
 * @returns {Promise<Response>} The proxied response with CORS headers.
 */
async function handleProxyRequest(request, targetUrl) {
  const requestOrigin = request.headers.get('Origin');
  const corsHeaders = createCorsHeaders(requestOrigin);

  try {
    const targetResponse = await forwardRequest(request, targetUrl);
    return addCorsHeadersToResponse(targetResponse, corsHeaders);
  } catch (error) {
    // Return a generic error response to the client
    return createJsonResponse({ error: `Failed to fetch target URL. ${error.message}` }, 502); // Bad Gateway
  }
}

/**
 * Creates the base set of permissive CORS headers.
 * Dynamically sets Allow-Origin and Allow-Credentials based on request origin.
 * @param {string | null} requestOrigin - The value of the Origin header from the request.
 * @returns {object} An object containing CORS headers.
 */
function createCorsHeaders(requestOrigin) {
  const headers = {
    // Define allowed methods explicitly
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS, PATCH',
    // Allow all requested headers
    'Access-Control-Allow-Headers': '*',
    // Expose all headers to the client-side script
    'Access-Control-Expose-Headers': '*',
    // Cache preflight response for 1 day
    'Access-Control-Max-Age': '86400',
  };

  // Set Allow-Origin and Allow-Credentials dynamically
  if (requestOrigin) {
    // If an Origin header is present, reflect it
    headers['Access-Control-Allow-Origin'] = requestOrigin;
    // Allow credentials (cookies, auth headers) when a specific origin is reflected
    headers['Access-Control-Allow-Credentials'] = 'true';
    // Vary header informs caches that the response depends on the Origin header
    headers['Vary'] = 'Origin';
  } else {
    // If no Origin header (e.g., direct access, non-browser client), allow any origin '*'
    headers['Access-Control-Allow-Origin'] = '*';
    // Cannot allow credentials with wildcard origin
  }

  return headers;
}


/**
 * Forwards the incoming request to the target URL after cleaning headers.
 * @param {Request} request - The original incoming request.
 * @param {URL} targetUrl - The URL object to forward the request to.
 * @returns {Promise<Response>} The response received from the target URL.
 */
async function forwardRequest(request, targetUrl) {
  // Create mutable headers object from the original request
  const forwardHeaders = new Headers(request.headers);

  // Remove headers that shouldn't be forwarded
  HEADERS_TO_STRIP.forEach(header => forwardHeaders.delete(header));

  // Construct the request to the target URL
  const targetRequest = new Request(targetUrl.toString(), {
    method: request.method,
    headers: forwardHeaders,
    body: request.body, // Pass through the request body
    redirect: 'follow', // Follow redirects from the target server
  });

  // Fetch the response from the target URL
  const response = await fetch(targetRequest);
  return response;
}

/**
 * Adds the specified CORS headers to a given Response object.
 * Creates a new Response to ensure headers are mutable.
 * @param {Response} response - The original response from the target.
 * @param {object} corsHeaders - An object containing the CORS headers to add.
 * @returns {Response} A new Response object with added CORS headers.
 */
function addCorsHeadersToResponse(response, corsHeaders) {
  // Create a mutable copy of the response headers
  const responseHeaders = new Headers(response.headers);

  // Add/overwrite CORS headers
  Object.entries(corsHeaders).forEach(([key, value]) => {
    responseHeaders.set(key, value);
  });

  // Return a new response with the original body/status and modified headers
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

/**
 * Helper function to create a JSON response.
 * @param {object} body - The JSON body content.
 * @param {number} status - The HTTP status code.
 * @param {HeadersInit} [headers] - Optional additional headers.
 * @returns {Response} A Response object with JSON body and content type.
 */
function createJsonResponse(body, status, headers = {}) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(body), { status, headers: responseHeaders });
}
