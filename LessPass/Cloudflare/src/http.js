// http.js
import { log } from './logs.js';

/**
 * Handles standard HTTP requests. Serves any path ending in "/info"
 * (with authentication) and returns a 404 for all other paths.
 *
 * @param {Request} request - The incoming HTTP request.
 * @param {object} env - The environment variables.
 * @param {URL} url - The request URL.
 * @param {object} config - The configuration object.
 * @param {object} logContext - The logging context.
 * @returns {Promise<Response>} The HTTP response.
 */
export async function handleHttpRequest(request, env, url, config, logContext) {
   const requestPath = url.pathname;
   const httpLogContext = { ...logContext, section: 'HTTP' };
   log.info(httpLogContext, "REQUEST", `Received request for path: ${requestPath}`);

   // Check if the request path ends with '/info'
   if (requestPath.endsWith('/info')) {
       // Handle the request using the info handler logic.
       log.info(httpLogContext, `${requestPath}:ROUTE`, "Routing to info handler.");
       // Pass the original url object to handleInfoRequest,
       return await handleInfoRequest(request, env, url, config, httpLogContext);
   }

   // For all other paths that don't end with /info, return a 404 Not Found response.
   log.info(httpLogContext, `${requestPath}:RESPONSE`, "Returning 404 Not Found (masquerade).");
   return new Response(
       `<!DOCTYPE html>
        <html>
        <head><title>404 Not Found</title></head>
        <body>
        <center><h1>404 Not Found</h1></center>
        <hr><center>nginx</center>
        </body>
        </html>`, {
       status: 404,
       headers: { 'Content-Type': 'text/html' }
   });
}

/**
 * Handles requests routed to the "/info" logic (paths ending in /info).
 * This endpoint requires basic authentication and returns information
 * about the request, environment, and configuration.
 *
 * @param {Request} request - The incoming HTTP request.
 * @param {object} env - The environment variables.
 * @param {URL} url - The request URL.
 * @param {object} config - The configuration object.
 * @param {object} httpLogContext - The logging context.
 * @returns {Promise<Response>} The HTTP response.
 */
async function handleInfoRequest(request, env, url, config, httpLogContext) {
   const infoLogContext = { ...httpLogContext, section: 'HTTP-INFO' };
   log.info(infoLogContext, `${url.pathname}:REQUEST`, `Handling info request for path: ${url.pathname}.`);

   // Check for basic authentication.
   const authHeader = request.headers.get('Authorization');
   // Use the password from the config object passed into the function
   if (!authHeader || authHeader !== `Basic ${btoa(':' + config.PASSWORD)}`) {
       log.warn(infoLogContext, `${url.pathname}:AUTH`, `Unauthorized access attempt to ${url.pathname}.`);
       // Return a 401 Unauthorized response with a WWW-Authenticate header.
       return new Response('Unauthorized', {
           status: 401,
           headers: {
               'WWW-Authenticate': 'Basic realm="User Visible Realm"',
           },
       });
   }

   // Gather information about the request.
   const requestInfo = {
       method: request.method,
       url: request.url,
       path: url.pathname,
       headers: Object.fromEntries(request.headers.entries()),
       cf: request.cf,
   };

   // Gather URL parameters.
   const urlParams = {
       uuid: url.searchParams.get('uuid'),
       proxy: url.searchParams.get('proxy'),
       doh: url.searchParams.get('doh'),
       password: url.searchParams.get('password'),
       log: url.searchParams.get('log'),
   };

   // Gather environment variables
   // Access env variables via the passed 'env' object
   const environmentVariables = {
       USER_ID: env.USER_ID,
       PROXY_ADDR: env.PROXY_ADDR,
       DOH_URL: env.DOH_URL,
       PASSWORD: env.PASSWORD,
       LOG_LEVEL: env.LOG_LEVEL,
   };

   // Combine all information into a single object.
   const info = {
       status: 'OK',
       request: requestInfo,
       config: config,
       environment: environmentVariables,
       param: urlParams,
   };
   log.debug(infoLogContext, `${url.pathname}:RESPONSE`, "Returning info response.");

   // Return the information as a JSON response.
   return new Response(JSON.stringify(info, null, 2), {
       status: 200,
       headers: { 'Content-Type': 'application/json' },
   });
}
