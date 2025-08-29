// Deno H2 TCP Tunnel Server

// --- Configuration ---
const PASSWORD = Deno.env.get('PASSWORD');
const HOSTNAME = Deno.env.get('HOSTNAME') || '0.0.0.0';
const PORT = parseInt(Deno.env.get('PORT') || '8080', 10);

// --- Server ---
console.log(`Starting tunnel server on http://${HOSTNAME}:${PORT}`);

Deno.serve({
  hostname: HOSTNAME,
  port: PORT,
  // The handler function is the equivalent of the Cloudflare Worker's `fetch` method.
  async handler(request) {
    // 1. Method
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    // 2. Authentication
    const authHeader = request.headers.get('Authorization');
    if (authHeader !== `Basic ${PASSWORD}`) {
      return new Response('Unauthorized', { status: 401 });
    }

    // 3. Target Host
    const targetHostHeader = request.headers.get('X-Target-Host');
    if (!targetHostHeader) {
      return new Response('Missing X-Target-Host header', { status: 400 });
    }
    const targetHost = targetHostHeader.toLowerCase().trim();
    if (!/^[a-zA-Z0-9\-.:[\]]+$/.test(targetHost)) {
      return new Response('Invalid target host', { status: 400 });
    }

    // 4. Target Port
    const targetPortStr = request.headers.get('X-Target-Port');
    if (!targetPortStr) {
      return new Response('Missing X-Target-Port header', { status: 400 });
    }
    const targetPort = parseInt(targetPortStr, 10);
    if (isNaN(targetPort) || targetPort < 1 || targetPort > 65535) {
      return new Response('Invalid target port', { status: 400 });
    }

    try {
      // 5. Connect to Target
      const socket = await Deno.connect({ hostname: targetHost, port: targetPort });

      // 6. Handle Client to Target Stream
      // Pipe the client's request body to the target socket.
      // This is the "Client -> Deno -> Target" stream.
      request.body.pipeTo(socket.writable).catch(error => {
        console.error(`Client -> Target pipe failed for ${targetHost}:${targetPort}:`, error.message);
      });

      // 7. Response Target to Client Stream
      // We pass socket.readable directly to the Response.
      // This is the "Target -> Deno -> Client" stream.
      return new Response(socket.readable, {
        status: 200,
        headers: {
          'Content-Type': 'application/grpc',
          'Cache-Control': 'no-cache',
          'X-Frame-Options': 'DENY',
        },
      });
    } catch (error) {
      // This catches initial setup errors (e.g., Deno.connect() failing)
      console.error('Tunnel setup error:', error.message);
      return new Response('Internal server error', { status: 500 });
    }
  },

  onError(error) {
    console.error('Fatal server error:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
});
