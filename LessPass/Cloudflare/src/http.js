// http.js
import { log } from './logs.js';

/**
 * Handles standard HTTP requests. Serves any path ending in "/info"
 * (with authentication) and returns a masquerading 404 for all other paths to
 * avoid fingerprinting.
 *
 * @param {Request} request - The incoming HTTP request.
 * @param {object} env - The environment variables from the Cloudflare runtime.
 * @param {URL} url - The request URL.
 * @param {object} config - The configuration object.
 * @param {object} logContext - The logging context.
 * @returns {Promise<Response>} The HTTP response.
 */
export async function handleHttpRequest(request, env, url, config, logContext) {
  const requestPath = url.pathname;
  const httpLogContext = { ...logContext, section: 'HTTP' };
  log.info(httpLogContext, 'REQUEST', `Received request for path: ${requestPath}`);
  if (requestPath.endsWith('/info')) {
    log.info(httpLogContext, `${requestPath}:ROUTE`, 'Routing to info handler.');
    return await handleInfoRequest(request, env, url, config, httpLogContext);
  }
  log.info(httpLogContext, `${requestPath}:RESPONSE`, 'Returning 404 Not Found (masquerade).');
  return new Response(
    `<!DOCTYPE html><html><head><title>404 Not Found</title></head><body><center><h1>404 Not Found</h1></center><hr><center>nginx</center></body></html>`,
    { status: 404, headers: { 'Content-Type': 'text/html' } }
  );
}

/**
 * Handles requests routed to the "/info" logic. This endpoint requires basic
 * authentication and returns diagnostic information about the request,
 * environment, and active configuration.
 *
 * @param {Request} request - The incoming HTTP request.
 * @param {object} env - The environment variables from the Cloudflare runtime.
 * @param {URL} url - The request URL.
 * @param {object} config - The configuration object.
 * @param {object} httpLogContext - The logging context.
 * @returns {Promise<Response>} The HTTP response.
 */
async function handleInfoRequest(request, env, url, config, httpLogContext) {
  const infoLogContext = { ...httpLogContext, section: 'HTTP-INFO' };
  log.info(infoLogContext, `${url.pathname}:REQUEST`, `Handling info request for path: ${url.pathname}.`);
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || authHeader !== `Basic ${btoa(':' + config.PASSWORD)}`) {
    log.warn(infoLogContext, `${url.pathname}:AUTH`, `Unauthorized access attempt to ${url.pathname}.`);
    return new Response('Unauthorized', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="User Visible Realm"' },
    });
  }
  const requestInfo = {
    method: request.method,
    url: request.url,
    path: url.pathname,
    headers: Object.fromEntries(request.headers.entries()),
    cf: request.cf, // Cloudflare-specific request properties
  };
  const urlParams = {
    uuid: url.searchParams.get('uuid'),
    relay: url.searchParams.get('relay'),
    doh: url.searchParams.get('doh'),
    password: url.searchParams.get('password') ? '[REDACTED]' : null,
    log: url.searchParams.get('log'),
  };
  const environmentVariables = {
    USER_ID: env.USER_ID,
    RELAY_ADDR: env.RELAY_ADDR,
    DOH_URL: env.DOH_URL,
    PASSWORD: env.PASSWORD ? '[REDACTED]' : undefined,
    LOG_LEVEL: env.LOG_LEVEL,
  };
  const info = {
    status: 'OK',
    request: requestInfo,
    config: config,
    environment: environmentVariables,
    param: urlParams,
  };
  log.debug(infoLogContext, `${url.pathname}:RESPONSE`, 'Returning info response.');
  return new Response(JSON.stringify(info, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
