// http.js
import { log } from './logs.js';

/**
 * Handles standard HTTP requests, routing to a diagnostic "/info" endpoint or
 * a masquerading 404 page.
 *
 * @param {Request} request - The incoming HTTP request.
 * @param {URL} url - The request URL.
 * @param {object} config - The configuration object.
 * @param {object} logContext - The logging context.
 * @returns {Promise<Response>} The HTTP response.
 */
export async function handleHttpRequest(request, url, config, logContext) {
  const requestPath = url.pathname;
  const httpLogContext = { ...logContext, section: 'HTTP' };
  log.info(httpLogContext, 'REQUEST', `Received request for path: ${requestPath}`);
  if (requestPath.endsWith('/info')) {
    log.info(httpLogContext, `${requestPath}:ROUTE`, 'Routing to info handler.');
    return await handleInfoRequest(request, url, config, httpLogContext);
  }
  log.info(httpLogContext, `${requestPath}:RESPONSE`, 'Returning 404 Not Found (masquerade).');
  return new Response(
    `<!DOCTYPE html><html><head><title>404 Not Found</title></head><body><center><h1>404 Not Found</h1></center><hr><center>nginx</center></body></html>`,
    { status: 404, headers: { 'Content-Type': 'text/html' } }
  );
}

/**
 * Handles requests to the "/info" endpoint, providing diagnostic data
 * after successful basic authentication.
 */
async function handleInfoRequest(request, url, config, httpLogContext) {
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
  };
  const environmentVariables = {
    USER_ID: Deno.env.get('USER_ID'),
    PASSWORD: Deno.env.get('PASSWORD') ? '[REDACTED]' : undefined,
    DOH_URL: Deno.env.get('DOH_URL'),
    LOG_LEVEL: Deno.env.get('LOG_LEVEL'),
  };
  const info = {
    status: 'OK',
    request: requestInfo,
    config: config,
    environment: environmentVariables,
  };
  log.debug(infoLogContext, `${url.pathname}:RESPONSE`, 'Returning info response.');
  return new Response(JSON.stringify(info, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
