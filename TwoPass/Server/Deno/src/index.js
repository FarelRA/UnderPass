// Deno H2 TCP Tunnel Server

const PASSWORD = Deno.env.get("PASSWORD");
const HOSTNAME = Deno.env.get("HOSTNAME") || "0.0.0.0";
const PORT = parseInt(Deno.env.get("PORT") || "8080", 10);

const sessions = new Map();

console.log(`[*] TCP Tunnel Server starting on ${HOSTNAME}:${PORT}`);

class TCPSession {
  constructor() {
    this.socket = null;
    this.ready = null;
  }

  async connect(targetHost, targetPort) {
    if (!this.ready) {
      this.ready = (async () => {
        this.socket = await Deno.connect({ hostname: targetHost, port: targetPort });
        console.log(`[<] [v2] Connected to ${targetHost}:${targetPort}`);
      })();
    }
    await this.ready;
  }

  async handleRequest(request, sessionId) {
    const targetHost = request.headers.get("X-Target-Host")?.toLowerCase().trim();
    const targetPort = parseInt(request.headers.get("X-Target-Port"), 10);

    await this.connect(targetHost, targetPort);

    // POST: Upload (Client -> Target)
    if (request.method === "POST") {
      console.log(`[=] [v2] Upload starting for session ${sessionId}`);
      await request.body.pipeTo(this.socket.writable);
      console.log(`[=] [v2] Upload complete for ${sessionId}`);
      return new Response(null, {
        status: 201,
        headers: {
          "Content-Type": "application/grpc",
          "Cache-Control": "no-cache",
        },
      });
    }

    // GET: Download (Target -> Client)
    if (request.method === "GET") {
      console.log(`[=] [v2] Download starting for session ${sessionId}`);
      return new Response(this.socket.readable, {
        headers: {
          "Content-Type": "application/grpc",
          "Cache-Control": "no-cache",
        },
      });
    }

    return new Response("Method not allowed", { status: 405 });
  }
}

// V1: Single bidirectional stream
async function handleV1(request, targetHost, targetPort) {
  console.log(`[>] [v1] Proxy request for ${targetHost}:${targetPort}`);

  try {
    const socket = await Deno.connect({ hostname: targetHost, port: targetPort });
    console.log(`[<] [v1] Connected to ${targetHost}:${targetPort}`);

    request.body.pipeTo(socket.writable).catch(err => {
      console.error(`[!] [v1] Upload stream error: ${err.message}`);
    });

    return new Response(socket.readable, {
      headers: {
        "Content-Type": "application/grpc",
        "Cache-Control": "no-cache",
      },
    });
  } catch (err) {
    console.error(`[!] [v1] Connection failed: ${err.message}`);
    return new Response("Connection failed", { status: 502 });
  }
}

Deno.serve({
  hostname: HOSTNAME,
  port: PORT,
  handler(request) {
    // Validate authentication
    if (request.headers.get("Authorization") !== `Basic ${PASSWORD}`) {
      console.log("[!] Unauthorized request");
      return new Response("Unauthorized", { status: 401 });
    }

    // Validate target
    const targetHost = request.headers.get("X-Target-Host")?.toLowerCase().trim();
    if (!targetHost || !/^[a-zA-Z0-9\-.:[\]]+$/.test(targetHost)) {
      console.log(`[!] Invalid target host: ${targetHost}`);
      return new Response("Invalid target host", { status: 400 });
    }

    const targetPort = parseInt(request.headers.get("X-Target-Port"), 10);
    if (!targetPort || targetPort < 1 || targetPort > 65535) {
      console.log(`[!] Invalid target port: ${targetPort}`);
      return new Response("Invalid target port", { status: 400 });
    }

    const sessionId = request.headers.get("X-Session-ID");

    // V2: Decoupled streams (POST + GET)
    if (sessionId) {
      console.log(`[*] [v2] Request for session ${sessionId}`);

      // Get or create session
      if (!sessions.has(sessionId)) {
        sessions.set(sessionId, new TCPSession());
      }
      const session = sessions.get(sessionId);

      return session.handleRequest(request, sessionId).finally(() => {
        if (request.method === "GET") {
          sessions.delete(sessionId);
          console.log(`[-] [v2] Session ${sessionId} cleaned up`);
        }
      });
    }

    // V1: Single bidirectional stream
    if (request.method !== "POST") {
      console.log(`[!] [v1] Method not allowed: ${request.method}`);
      return new Response("Method not allowed", { status: 405 });
    }

    return handleV1(request, targetHost, targetPort);
  },
});
