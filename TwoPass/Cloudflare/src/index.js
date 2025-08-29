import { connect } from 'cloudflare:sockets';

export default {
  async fetch(request, env, ctx) {
    // 1. Method
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    // 2. Authentication
    const authHeader = request.headers.get('Authorization');
    if (authHeader !== `Basic ${env.PASSWORD}`) {
      return new Response('Unauthorized', { status: 401 });
    }

    // 3. Target Host
    const targetHost = request.headers.get('X-Target-Host').toLowerCase().trim();
    if (!targetHost || !/^[a-zA-Z0-9\-.:[\]]+$/.test(targetHost)) {
      return new Response('Invalid target host', { status: 400 });
    }

    // 4. Target Port
    const targetPort = parseInt(request.headers.get('X-Target-Port'), 10);
    if (!targetPort || targetPort < 1 || targetPort > 65535) {
      return new Response('Invalid target port', { status: 400 });
    }

    try {
      // 5. Connect to Target
      const socket = connect(
        { hostname: targetHost, port: targetPort },
        { allowHalfOpen: true }
      );

      // 6. Handle Client to Target Stream
      // Pipe the client's request body to the target socket.
      // This is the "Client -> Worker -> Target" stream.
      ctx.waitUntil(request.body.pipeTo(socket.writable));

      // 7. Response Target to Client Stream
      // We pass socket.readable directly to the Response.
      // This is the "Target -> Worker -> Client" stream.
      return new Response(socket.readable, {
        status: 200,
        headers: {
          // Use gRPC to bypass Cloudflare
          'Content-Type': 'application/grpc',
          'Cache-Control': 'no-cache',
          'X-Frame-Options': 'DENY',
        },
      });
    } catch (error) {
      // This catches initial setup errors (e.g., connect() failing)
      console.error('Tunnel setup error:', error.message);
      return new Response('Internal server error', { status: 500 });
    }
  },
};
