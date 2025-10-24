// Deno H2 TCP Tunnel Server
const PASSWORD = Deno.env.get('PASSWORD');
const HOSTNAME = Deno.env.get('HOSTNAME') || '0.0.0.0';
const PORT = parseInt(Deno.env.get('PORT') || '8080', 10);

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

const sessions = new Map();

/**
 * TCPSession class for managing persistent TCP connections in V2 protocol
 */
class TCPSession {
  constructor() {
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
          this.socket = await Deno.connect({ 
            hostname: targetHost, 
            port: targetPort 
          });
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
   * Handles incoming requests for this session
   * @param {Request} request - Incoming HTTP request
   * @returns {Response} HTTP response
   */
  async handleRequest(request) {
    const targetHost = request.headers.get('X-Target-Host')?.toLowerCase().trim();
    const targetPort = parseInt(request.headers.get('X-Target-Port'), 10);
    const sessionId = request.headers.get('X-Session-ID');

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
 * @returns {Response} HTTP response with bidirectional stream
 */
async function handleV1(request, targetHost, targetPort) {
  const requestId = Math.random().toString(36).substring(2, 8);
  console.log(`[>] [v1] [${requestId}] Proxy request for ${targetHost}:${targetPort}`);

  try {
    const socket = await Deno.connect({
      hostname: targetHost,
      port: targetPort
    });

    console.log(`[<] [v1] [${requestId}] Connected to ${targetHost}:${targetPort}`);

    request.body.pipeTo(socket.writable, { preventClose: true }).catch(err => {
      console.error(`[!] [v1] [${requestId}] Upload stream error: ${err.message}`);
    });

    return new Response(socket.readable, {
      headers: HEADERS,
    });
  } catch (err) {
    console.error(`[!] [v1] [${requestId}] Connection failed: ${err.message}`);
    return new Response('Connection failed', { status: STATUS.BAD_GATEWAY });
  }
}

console.log(`[*] TCP Tunnel Server starting on ${HOSTNAME}:${PORT}`);
Deno.serve({
  hostname: HOSTNAME,
  port: PORT,
  handler(request) {
    // Validate authentication
    if (request.headers.get('Authorization') !== `Basic ${PASSWORD}`) {
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
      const session = sessions.get(sessionId)
        || sessions.set(sessionId, new TCPSession()).get(sessionId);
      return session.handleRequest(request);
    }

    // V1: Single bidirectional stream
    if (request.method === 'POST') {
      return handleV1(request, targetHost, targetPort);
    }

    console.log(`[!] [v1] Method not allowed: ${request.method}`);
    return new Response('Method not allowed', { status: STATUS.METHOD_NOT_ALLOWED });
  },
});
