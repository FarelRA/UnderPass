// Deno H2 TCP Tunnel Server

const PASSWORD = Deno.env.get("PASSWORD");
const HOSTNAME = Deno.env.get("HOSTNAME") || "0.0.0.0";
const PORT = parseInt(Deno.env.get("PORT") || "8080", 10);

// HTTP Status codes
const STATUS_OK = 200;
const STATUS_CREATED = 201;
const STATUS_BAD_REQUEST = 400;
const STATUS_UNAUTHORIZED = 401;
const STATUS_METHOD_NOT_ALLOWED = 405;
const STATUS_BAD_GATEWAY = 502;

// Session configuration
const SESSION_TTL_MS = 60000; // 60 seconds

const sessions = new Map();
const sessionTimers = new Map();

console.log(`[*] TCP Tunnel Server starting on ${HOSTNAME}:${PORT}`);

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
   * @param {string} sessionId - Session ID
   * @returns {Response} HTTP response
   */
  async handleRequest(request, sessionId) {
    const targetHost = request.headers.get("X-Target-Host")?.toLowerCase().trim();
    const targetPort = parseInt(request.headers.get("X-Target-Port"), 10);

    try {
      await this.connect(targetHost, targetPort, sessionId);
    } catch (err) {
      return new Response("Connection failed", { status: STATUS_BAD_GATEWAY });
    }

    // POST: Upload (Client -> Target)
    if (request.method === "POST") {
      console.log(`[=] [v2] [${sessionId}] Upload starting`);
      try {
        await request.body.pipeTo(this.socket.writable, { preventClose: true });
        console.log(`[=] [v2] [${sessionId}] Upload complete`);
        return new Response(null, {
          status: STATUS_CREATED,
          headers: {
            "Content-Type": "application/grpc",
            "Cache-Control": "no-cache",
          },
        });
      } catch (err) {
        console.error(`[!] [v2] [${sessionId}] Upload error: ${err.message}`);
        this.cleanup(sessionId);
        return new Response("Upload failed", { status: STATUS_BAD_GATEWAY });
      }
    }

    // GET: Download (Target -> Client)
    if (request.method === "GET") {
      console.log(`[=] [v2] [${sessionId}] Download starting`);
      return new Response(this.socket.readable, {
        headers: {
          "Content-Type": "application/grpc",
          "Cache-Control": "no-cache",
        },
      });
    }

    return new Response("Method not allowed", { status: STATUS_METHOD_NOT_ALLOWED });
  }

  /**
   * Cleanup socket resources
   * @param {string} sessionId - Session ID for logging
   */
  cleanup(sessionId) {
    if (this.socket) {
      try {
        this.socket.close();
        console.log(`[-] [v2] [${sessionId}] Socket cleaned up`);
      } catch (err) {
        console.error(`[!] [v2] [${sessionId}] Cleanup error: ${err.message}`);
      }
      this.socket = null;
      this.ready = null;
    }
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
  const requestId = crypto.randomUUID().substring(0, 8);
  console.log(`[>] [v1] [${requestId}] Proxy request for ${targetHost}:${targetPort}`);

  try {
    const socket = await Deno.connect({ hostname: targetHost, port: targetPort });
    console.log(`[<] [v1] [${requestId}] Connected to ${targetHost}:${targetPort}`);

    request.body.pipeTo(socket.writable, { preventClose: true }).catch(err => {
      console.error(`[!] [v1] [${requestId}] Upload stream error: ${err.message}`);
    });

    return new Response(socket.readable, {
      headers: {
        "Content-Type": "application/grpc",
        "Cache-Control": "no-cache",
      },
    });
  } catch (err) {
    console.error(`[!] [v1] [${requestId}] Connection failed: ${err.message}`);
    return new Response("Connection failed", { status: STATUS_BAD_GATEWAY });
  }
}

/**
 * Validates target hostname format
 * @param {string} targetHost - Target hostname to validate
 * @returns {boolean} True if valid
 */
function isValidTargetHost(targetHost) {
  if (!targetHost) return false;
  // Allow: domain names, IPv4, IPv6 (with brackets)
  return /^([a-z0-9]([a-z0-9\-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9\-]{0,61}[a-z0-9])?$|^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$|^\[[0-9a-f:]+\]$/i.test(targetHost);
}

/**
 * Cleanup expired session
 * @param {string} sessionId - Session ID to cleanup
 */
function cleanupSession(sessionId) {
  const session = sessions.get(sessionId);
  if (session) {
    session.cleanup(sessionId);
    sessions.delete(sessionId);
  }
  sessionTimers.delete(sessionId);
  console.log(`[-] [v2] [${sessionId}] Session expired and cleaned up`);
}

Deno.serve({
  hostname: HOSTNAME,
  port: PORT,
  handler(request) {
    // Validate authentication
    if (request.headers.get("Authorization") !== `Basic ${PASSWORD}`) {
      console.log("[!] Unauthorized request");
      return new Response("Unauthorized", { status: STATUS_UNAUTHORIZED });
    }

    // Validate target
    const targetHost = request.headers.get("X-Target-Host")?.toLowerCase().trim();
    if (!isValidTargetHost(targetHost)) {
      console.log(`[!] Invalid target host: ${targetHost}`);
      return new Response("Invalid target host", { status: STATUS_BAD_REQUEST });
    }

    const targetPort = parseInt(request.headers.get("X-Target-Port"), 10);
    if (!targetPort || targetPort < 1 || targetPort > 65535) {
      console.log(`[!] Invalid target port: ${targetPort}`);
      return new Response("Invalid target port", { status: STATUS_BAD_REQUEST });
    }

    const sessionId = request.headers.get("X-Session-ID");

    // V2: Decoupled streams (POST + GET)
    if (sessionId) {
      console.log(`[*] [v2] [${sessionId}] Request for session`);

      // Get or create session
      if (!sessions.has(sessionId)) {
        sessions.set(sessionId, new TCPSession());
        // Set TTL cleanup timer
        const timer = setTimeout(() => cleanupSession(sessionId), SESSION_TTL_MS);
        sessionTimers.set(sessionId, timer);
      } else {
        // Reset TTL timer on activity
        clearTimeout(sessionTimers.get(sessionId));
        const timer = setTimeout(() => cleanupSession(sessionId), SESSION_TTL_MS);
        sessionTimers.set(sessionId, timer);
      }

      const session = sessions.get(sessionId);

      return session.handleRequest(request, sessionId).finally(() => {
        if (request.method === "GET") {
          // Clear timer and cleanup on GET completion
          clearTimeout(sessionTimers.get(sessionId));
          sessionTimers.delete(sessionId);
          session.cleanup(sessionId);
          sessions.delete(sessionId);
          console.log(`[-] [v2] [${sessionId}] Session cleaned up`);
        }
      });
    }

    // V1: Single bidirectional stream
    if (request.method !== "POST") {
      console.log(`[!] [v1] Method not allowed: ${request.method}`);
      return new Response("Method not allowed", { status: STATUS_METHOD_NOT_ALLOWED });
    }

    return handleV1(request, targetHost, targetPort);
  },
});
