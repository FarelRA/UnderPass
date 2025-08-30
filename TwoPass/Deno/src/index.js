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
      // 1. Decouple the response stream from the raw socket.
      const { readable, writable } = new TransformStream();

      // 2. Run the entire tunnel logic in a background task.
      (async () => {
        let socket;
        try {
          console.log(`Connecting to ${targetHost}:${targetPort} ...`);
          socket = await Deno.connect({ hostname: targetHost, port: targetPort });
          console.log(`Connected to ${targetHost}:${targetPort}`);

          // Create the two pipe promises to run in parallel.
          // Let pipeTo handle closing the socket's writable stream automatically.
          const clientToTarget = request.body.pipeTo(socket.writable);
          const targetToClient = socket.readable.pipeTo(writable);

          // Add individual logging to see when each pipe finishes.
          clientToTarget.catch(err => console.log(`[INFO] Client -> Target pipe ended: ${err.message}`));
          targetToClient.catch(err => console.log(`[INFO] Target -> Client pipe ended: ${err.message}`));

          console.log(`Pipes for ${targetHost}:${targetPort} are running in parallel.`);

          // This is the key: wait for BOTH pipes to finish, for any reason.
          await Promise.allSettled([clientToTarget, targetToClient]);

          console.log(`Both pipes for ${targetHost}:${targetPort} have completed.`);

        } catch (err) {
          // This only catches the initial Deno.connect error.
          console.error(`Tunnel setup error for ${targetHost}:${targetPort}: ${err.message}`);
          await writable.abort(err).catch(() => {});
        } finally {
          // This finally block runs only after both pipes are settled.
          // This prevents the race condition and the BadResource error.
          console.log(`Cleaning up resources for ${targetHost}:${targetPort}.`);
          if (socket) {
            try {
              // A simple close is sufficient here because both streams are done.
              socket.close();
            } catch (e) {
              // It's possible the resource is already gone, which is fine.
              if (!(e instanceof Deno.errors.BadResource)) {
                console.error(`Unexpected cleanup error: ${e.message}`);
              }
            }
          }
        }
      })();

      // 3. Immediately return the clean, decoupled stream as the response.
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
