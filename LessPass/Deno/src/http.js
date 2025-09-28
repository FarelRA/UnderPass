// http.js
import { log } from './logs.js';

/**
 * Handles standard HTTP requests.
 * @param {Request} request - The incoming HTTP request.
 * @param {object} config - The configuration object.
 * @param {object} logContext - The logging context.
 * @returns {Promise<Response>} The HTTP response.
 */
export async function handleHttpRequest(request, config, logContext) {
    const url = new URL(request.url);
    const httpLogContext = { ...logContext, section: 'HTTP' };
    log.info(httpLogContext, 'REQUEST', `Received request for path: ${url.pathname}`);

    if (url.pathname.endsWith('/info')) {
        log.info(httpLogContext, `${url.pathname}:ROUTE`, 'Routing to info handler.');
        return handleInfoRequest(request, url, config, httpLogContext);
    }

    return new Response('Not Found', { status: 404 });
}

/**
 * Handles requests to the "/info" endpoint.
 * @param {Request} request - The incoming HTTP request.
 * @param {URL} url - The request URL.
 * @param {object} config - The configuration object.
 * @param {object} httpLogContext - The logging context.
 */
function handleInfoRequest(request, url, config, httpLogContext) {
    const infoLogContext = { ...httpLogContext, section: 'HTTP-INFO' };
    log.info(infoLogContext, 'REQUEST', `Handling info request.`);

    const authHeader = request.headers.get('Authorization');
    if (!authHeader || authHeader !== `Basic ${btoa(':' + config.PASSWORD)}`) {
        log.warn(infoLogContext, 'AUTH', 'Unauthorized access attempt.');
        return new Response('Unauthorized', {
            status: 401,
            headers: { 'WWW-Authenticate': 'Basic realm="VLESS Info"' },
        });
    }

    const info = {
        status: 'OK',
        config: {
            USER_ID: config.USER_ID,
            DOH_URL: config.DOH_URL,
            LOG_LEVEL: config.LOG_LEVEL,
        },
        environment: {
            USER_ID: Deno.env.get('USER_ID') || 'Not Set',
            PASSWORD: Deno.env.get('PASSWORD') ? 'Set' : 'Not Set',
            DOH_URL: Deno.env.get('DOH_URL') || 'Not Set',
            LOG_LEVEL: Deno.env.get('LOG_LEVEL') || 'Not Set',
        },
    };

    return new Response(JSON.stringify(info, null, 2), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}
