import { connect } from 'cloudflare:sockets';

const STATUS = {
  OK: 200,
  CREATED: 201,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  METHOD_NOT_ALLOWED: 405,
  BAD_GATEWAY: 502,
};

const HEADERS = {
  'Content-Type': 'application/grpc',
  'Cache-Control': 'no-cache',
};

/**
 * TCPSession Durable Object for managing persistent TCP connections across V2 requests
 */
export class TCPSession {
  constructor(state, env) {
    this.socket = null;
    this.ready = null;
  }

  /**
   * Establishes TCP connection to target (idempotent via this.ready promise)
   * @param {string} targetHost - Target hostname or IP
   * @param {number} targetPort - Target port number
   * @param {string} sessionId - Session ID for logging
   */
  async connect(targetHost, targetPort, sessionId) {
    if (!this.ready) {
      this.ready = (async () => {
        try {
          this.socket = connect(
            { hostname: targetHost, port: targetPort },
            { allowHalfOpen: true }
          );
          console.log(`[<] [v2] [${sessionId}] Connected to ${targetHost}:${targetPort}`);
        } catch (err) {
          console.error(`[!] [v2] [${sessionId}] Connection failed: ${err.message}`);
          throw err;
        }
      })();
    }
    await this.ready;
  }

  /**
   * Handles incoming requests for this Durable Object session
   * @param {Request} request - Incoming HTTP request
   * @returns {Response} HTTP response
   */
  async fetch(request, targetHost, targetPort, sessionId) {
    console.log(`[*] [v2] [${sessionId}] Request for session`);

    // Try connect to the target
    try {
      await this.connect(targetHost, targetPort, sessionId);
    } catch (err) {
      return new Response('Connection failed', { status: STATUS.BAD_GATEWAY });
    }

    // POST: Upload (Client -> Target)
    if (request.method === 'POST') {
      console.log(`[=] [v2] [${sessionId}] Upload starting`);
      try {
        await request.body.pipeTo(this.socket.writable, { preventClose: true });
        return new Response(null, {
          status: STATUS.CREATED,
          headers: HEADERS,
        });
      } catch (err) {
        console.error(`[!] [v2] [${sessionId}] Upload error: ${err.message}`);
        return new Response('Upload failed', { status: STATUS.BAD_GATEWAY });
      }
    }

    // GET: Download (Target -> Client)
    if (request.method === 'GET') {
      console.log(`[=] [v2] [${sessionId}] Download starting`);
      return new Response(this.socket.readable, {
        headers: HEADERS,
      });
    }

    return new Response('Method not allowed', { status: STATUS.METHOD_NOT_ALLOWED });
  }
}

/**
 * V1: Single bidirectional stream handler
 * @param {Request} request - Incoming HTTP request
 * @param {string} targetHost - Target hostname or IP
 * @param {number} targetPort - Target port number
 * @param {ExecutionContext} ctx - Cloudflare execution context
 * @returns {Response} HTTP response with bidirectional stream
 */
async function handleV1(request, targetHost, targetPort, ctx) {
  const requestId = Math.random().toString(36).substring(2, 8);
  console.log(`[>] [v1] [${requestId}] Proxy request for ${targetHost}:${targetPort}`);

  try {
    const socket = connect(
      { hostname: targetHost, port: targetPort },
      { allowHalfOpen: true }
    );

    console.log(`[<] [v1] [${requestId}] Connected to ${targetHost}:${targetPort}`);

    ctx.waitUntil(
      request.body.pipeTo(socket.writable, { preventClose: true }).catch(err => {
        console.error(`[!] [v1] [${requestId}] Upload stream error: ${err.message}`);
      })
    );

    return new Response(socket.readable, {
      headers: HEADERS,
    });
  } catch (error) {
    console.error(`[!] [v1] [${requestId}] Connection failed: ${error.message}`);
    return new Response('Connection failed', { status: STATUS.BAD_GATEWAY });
  }
}

export default {
  async fetch(request, env, ctx) {
    // Validate authentication
    if (request.headers.get('Authorization') !== `Basic ${env.PASSWORD}`) {
      console.log('[!] Unauthorized request');
      return new Response('Unauthorized', { status: STATUS.UNAUTHORIZED });
    }

    // Validate target
    const targetHost = request.headers.get('X-Target-Host')?.toLowerCase().trim();
    if (!targetHost || !/^[\w\-.:[\]]+$/.test(targetHost)) {
      console.log(`[!] Invalid target host: ${targetHost}`);
      return new Response('Invalid target host', { status: STATUS.BAD_REQUEST });
    }

    const targetPort = parseInt(request.headers.get('X-Target-Port'), 10);
    if (!targetPort || targetPort < 1 || targetPort > 65535) {
      console.log(`[!] Invalid target port: ${targetPort}`);
      return new Response('Invalid target port', { status: STATUS.BAD_REQUEST });
    }

    const sessionId = request.headers.get('X-Session-ID');

    // V2: Decoupled streams (POST + GET)
    if (sessionId) {
      const id = env.TCP_SESSION.idFromName(sessionId);
      const stub = env.TCP_SESSION.get(id);
      return stub.fetch(request, targetHost, targetPort, sessionId);
    }

    // V1: Single bidirectional stream
    if (request.method === 'POST') {
      return handleV1(request, targetHost, targetPort, ctx);
    }

    console.log(`[!] [v1] Method not allowed: ${request.method}`);
    return new Response('Method not allowed', { status: STATUS.METHOD_NOT_ALLOWED });
  }
};
