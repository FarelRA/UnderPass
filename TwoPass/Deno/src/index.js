// Deno H2 TCP Tunnel Server with Logging

// --- Configuration ---
const PASSWORD = Deno.env.get('PASSWORD');
const HOSTNAME = Deno.env.get('HOSTNAME') || '0.0.0.0';
const PORT = parseInt(Deno.env.get('PORT') || '8080', 10);

console.log(`Starting TCP Tunnel Server on ${HOSTNAME}:${PORT}`);

// --- Server ---
Deno.serve({
  hostname: HOSTNAME,
  port: PORT,
  async handler(request) {
    console.log('--- New Request ---');
    console.log(`Method: ${request.method}`);
    console.log('Headers:', Object.fromEntries(request.headers.entries()));

    // 1. Method
    if (request.method !== 'POST') {
      console.warn('Rejected: invalid method');
      return new Response('Method not allowed', { status: 405 });
    }

    // 2. Authentication
    const authHeader = request.headers.get('Authorization');
    if (authHeader !== `Basic ${PASSWORD}`) {
      console.warn('Rejected: unauthorized');
      return new Response('Unauthorized', { status: 401 });
    }
    console.log('Authentication passed');

    // 3. Target Host
    const targetHostHeader = request.headers.get('X-Target-Host');
    if (!targetHostHeader) {
      console.warn('Rejected: missing target host');
      return new Response('Missing X-Target-Host header', { status: 400 });
    }
    const targetHost = targetHostHeader.toLowerCase().trim();
    if (!/^[a-zA-Z0-9\-.:[\]]+$/.test(targetHost)) {
      console.warn(`Rejected: invalid target host "${targetHost}"`);
      return new Response('Invalid target host', { status: 400 });
    }
    console.log(`Target Host: ${targetHost}`);

    // 4. Target Port
    const targetPortStr = request.headers.get('X-Target-Port');
    if (!targetPortStr) {
      console.warn('Rejected: missing target port');
      return new Response('Missing X-Target-Port header', { status: 400 });
    }
    const targetPort = parseInt(targetPortStr, 10);
    if (isNaN(targetPort) || targetPort < 1 || targetPort > 65535) {
      console.warn(`Rejected: invalid target port "${targetPortStr}"`);
      return new Response('Invalid target port', { status: 400 });
    }
    console.log(`Target Port: ${targetPort}`);

    try {
      // 5. Connect to Target
      console.log(`Connecting to ${targetHost}:${targetPort} ...`);
      const socket = await Deno.connect({ hostname: targetHost, port: targetPort });
      console.log(`Connected to ${targetHost}:${targetPort}`);

      const { readable, writable } = new TransformStream();

      // 6. The Target -> Client stream
      console.log(`Streaming Target -> Client (${targetHost}:${targetPort})`);
      socket.readable.pipeTo(writable).catch((err) => {
        console.warn(`Target -> Client pipe ended for ${targetHost}:${targetPort}: ${err.message}`);
      });

      // 7. The Client -> Target stream
      (async () => {
        try {
          console.log(`Streaming Client -> Target (${targetHost}:${targetPort})`);
          await request.body.pipeTo(socket.writable);
        } catch (err) {
          console.warn(`Client -> Target pipe ended for ${targetHost}:${targetPort}: ${err.message}`);
          socket.close();
        }
      })();

      // 8. Response to Client
      return new Response(readable, {
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
