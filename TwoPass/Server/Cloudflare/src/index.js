import { connect } from 'cloudflare:sockets';

export class TCPSession {
  constructor(state, env) {
    this.socket = null;
    this.ready = null;
  }

  async connect(targetHost, targetPort) {
    if (!this.ready) {
      this.ready = (async () => {
        this.socket = connect(
          { hostname: targetHost, port: targetPort },
          { allowHalfOpen: true }
        );
        console.log(`[<] [v2] Connected to ${targetHost}:${targetPort}`);
      })();
    }
    await this.ready;
  }

  async fetch(request) {
    const sessionId = request.headers.get('X-Session-ID');
    const targetHost = request.headers.get('X-Target-Host');
    const targetPort = parseInt(request.headers.get('X-Target-Port'), 10);

    await this.connect(targetHost, targetPort);

    // POST: Upload (Client -> Target)
    if (request.method === 'POST') {
      console.log(`[=] [v2] Upload starting for session ${sessionId}`);
      request.body.pipeTo(this.socket.writable, { preventClose: true });
      return new Response(null, {
        status: 201,
        headers: {
          'Content-Type': 'application/grpc',
          'Cache-Control': 'no-cache',
        }
      });
    }

    // GET: Download (Target -> Client)
    if (request.method === 'GET') {
      console.log(`[=] [v2] Download starting for session ${sessionId}`);
      return new Response(this.socket.readable, {
        headers: {
          'Content-Type': 'application/grpc',
          'Cache-Control': 'no-cache',
        }
      });
    }

    return new Response('Method not allowed', { status: 405 });
  }
}

// V1: Single bidirectional stream
async function handleV1(request, targetHost, targetPort, ctx) {
  console.log(`[>] [v1] Proxy request for ${targetHost}:${targetPort}`);

  try {
    const socket = connect(
      { hostname: targetHost, port: targetPort },
      { allowHalfOpen: true }
    );

    console.log(`[<] [v1] Connected to ${targetHost}:${targetPort}`);

    ctx.waitUntil(request.body.pipeTo(socket.writable, { preventClose: true }));

    return new Response(socket.readable, {
      headers: {
        'Content-Type': 'application/grpc',
        'Cache-Control': 'no-cache',
      }
    });
  } catch (error) {
    console.log(`[!] [v1] Connection failed: ${error.message}`);
    return new Response('Connection failed', { status: 502 });
  }
}

export default {
  async fetch(request, env, ctx) {
    // Validate authentication
    const authHeader = request.headers.get('Authorization');
    if (authHeader !== `Basic ${env.PASSWORD}`) {
      console.log('[!] Unauthorized request');
      return new Response('Unauthorized', { status: 401 });
    }

    // Validate target
    const targetHost = request.headers.get('X-Target-Host')?.toLowerCase().trim();
    if (!targetHost || !/^[a-zA-Z0-9\-.:[\]]+$/.test(targetHost)) {
      console.log(`[!] Invalid target host: ${targetHost}`);
      return new Response('Invalid target host', { status: 400 });
    }

    const targetPort = parseInt(request.headers.get('X-Target-Port'), 10);
    if (!targetPort || targetPort < 1 || targetPort > 65535) {
      console.log(`[!] Invalid target port: ${targetPort}`);
      return new Response('Invalid target port', { status: 400 });
    }

    const sessionId = request.headers.get('X-Session-ID');

    // V2: Decoupled streams (POST + GET)
    if (sessionId) {
      console.log(`[*] [v2] Request for session ${sessionId}`);
      const id = env.TCP_SESSION.idFromName(sessionId);
      const stub = env.TCP_SESSION.get(id);
      return stub.fetch(request);
    }

    // V1: Single bidirectional stream
    if (request.method !== 'POST') {
      console.log(`[!] [v1] Method not allowed: ${request.method}`);
      return new Response('Method not allowed', { status: 405 });
    }

    return handleV1(request, targetHost, targetPort, ctx);
  }
};
