// http.js
import { log } from './logs.js';

/**
 * Handles standard HTTP requests. Currently, it serves an "/info" endpoint
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

    if (requestPath === '/info') {
        // Handle the "/info" request (requires authentication).
        return await handleInfoRequest(request, env, url, config, httpLogContext);
    }

    // For all other paths, return a 404 Not Found response (masquerading as nginx).
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
 * Handles requests to the "/info" endpoint. This endpoint requires basic
 * authentication and returns information about the request, environment,
 * and configuration.
 *
 * @param {Request} request - The incoming HTTP request.
 * @param {object} env - The environment variables.
 * @param {URL} url - The request URL.
 * @param {object} config - The configuration object.
 * @param {object} httpLogContext - The logging context.
 * @returns {Promise<Response>} The HTTP response.
 */
async function handleInfoRequest(request, env, url, config, httpLogContext) {
    const infoLogContext = { ...httpLogContext, section: 'HTTP' };
    log.info(infoLogContext, "/info:REQUEST", "Handling /info request.");

    // Check for basic authentication.
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || authHeader !== `Basic ${btoa(':' + config.PASSWORD)}`) {
        log.warn(infoLogContext, "/info:AUTH", "Unauthorized access attempt to /info.");
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
        headers: Object.fromEntries(request.headers.entries()),
        cf: request.cf, // Cloudflare-specific information.
    };

    // Gather URL parameters.
    const urlParams = {
        uuid: url.searchParams.get('uuid'),
        proxy: url.searchParams.get('proxy'),
        doh: url.searchParams.get('doh'),
        password: url.searchParams.get('password'),
        log: url.searchParams.get('log'),
    };

    // Gather environment variables (including sensitive ones - be cautious).
    const environmentVariables = {
        USER_ID: env.USER_ID,
        PROXY_ADDR: env.PROXY_ADDR,
        DOH_URL: env.DOH_URL,
        PASSWORD: env.PASSWORD, // REMOVE IN PRODUCTION - This is for debugging only!
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
    log.debug(infoLogContext, "/info:RESPONSE", "Returning /info response.");

    // Return the information as a JSON response.
    return new Response(JSON.stringify(info, null, 2), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}
