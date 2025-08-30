// Deno H2 TCP Tunnel Server

// --- Configuration ---
const PASSWORD = Deno.env.get('PASSWORD');
const HOSTNAME = Deno.env.get('HOSTNAME') || '0.0.0.0';
const PORT = parseInt(Deno.env.get('PORT') || '8080', 10);

// --- Server ---
Deno.serve({
  hostname: HOSTNAME,
  port: PORT,
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
      const socket = await Deno.connect({
        hostname: targetHost,
        port: targetPort
      });

      // 6. Handle Client to Target Stream
      request.body.pipeTo(socket.writable)

      // 7. Response with Target to Client Stream
      return new Response(socket.readable, {
        status: 200,
        headers: {
          'Content-Type': 'application/grpc',
          'Cache-Control': 'no-cache',
          'X-Frame-Options': 'DENY',
        },
      });
    } catch (error) {
      console.error(`Tunnel setup error for ${targetHost}:${targetPort}:`, error.message);
      return new Response('Internal server error', { status: 500 });
    }
  },

  onError(error) {
    console.error('Fatal server error:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
});
