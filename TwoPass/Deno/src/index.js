// Deno H2 TCP Tunnel Server (Supports v1 and v2 protocols)

// --- Configuration ---
const PASSWORD = Deno.env.get("PASSWORD");
const HOSTNAME = Deno.env.get("HOSTNAME") || "0.0.0.0";
const PORT = parseInt(Deno.env.get("PORT") || "8080", 10);

// --- V2 Protocol State ---
/**
 * This map holds promises for the downstream (target->client) connections.
 * Key: tunnelId (string)
 * Value: { promise: Promise<ReadableStream>, resolve: (stream: ReadableStream) => void, reject: (error: any) => void }
 * @type {Map<string, {promise: Promise<ReadableStream>, resolve: (stream: ReadableStream) => void, reject: (error: any) => void}>}
 */
const tunnels = new Map();

// --- Server ---
console.log(`Deno H2 TCP Tunnel Server starting on ${HOSTNAME}:${PORT}`);
console.log("Mode: Supporting v1 (single stream) and v2 (decoupled streams)");

Deno.serve({
  hostname: HOSTNAME,
  port: PORT,
  async handler(request) {
    // Shared validation for both protocols
    const authHeader = request.headers.get("Authorization");
    if (authHeader !== `Basic ${PASSWORD}`) {
      return new Response("Unauthorized", { status: 401 });
    }

    const tunnelId = request.headers.get("X-Tunnel-Id");
    if (tunnelId) {
      // --- V2 Protocol: Decoupled Streams ---
      return handleV2Request(request, tunnelId);
    } else {
      // --- V1 Protocol: Single Bidirectional Stream ---
      return handleV1Request(request);
    }
  },

  onError(error) {
    console.error("Fatal server error:", error);
    return new Response("Internal Server Error", { status: 500 });
  },
});

// --- V1 Protocol Handler ---
/**
 * @param {Request} request
 */
async function handleV1Request(request) {
  // 1. Method
  if (request.method !== "POST") {
    return new Response("[V1] Method not allowed", { status: 405 });
  }

  // 2. Target Host
  const targetHostHeader = request.headers.get("X-Target-Host");
  if (!targetHostHeader) {
    return new Response("[V1] Missing X-Target-Host header", { status: 400 });
  }
  const targetHost = targetHostHeader.toLowerCase().trim();
  if (!/^[a-zA-Z0-9\-.:[\]]+$/.test(targetHost)) {
    return new Response("[V1] Invalid target host", { status: 400 });
  }

  // 3. Target Port
  const targetPortStr = request.headers.get("X-Target-Port");
  if (!targetPortStr) {
    return new Response("[V1] Missing X-Target-Port header", { status: 400 });
  }
  const targetPort = parseInt(targetPortStr, 10);
  if (isNaN(targetPort) || targetPort < 1 || targetPort > 65535) {
    return new Response("[V1] Invalid target port", { status: 400 });
  }

  try {
    // 4. Connect to Target
    const socket = await Deno.connect({
      hostname: targetHost,
      port: targetPort,
    });
    console.log(`[V1] Connected to target ${targetHost}:${targetPort}`);

    // 5. Handle Client to Target Stream
    request.body.pipeTo(socket.writable).catch(err => {
      console.error(`[V1] client-to-target stream error:`, err.message);
    });

    // 6. Response with Target to Client Stream
    return new Response(socket.readable, {
      status: 200,
      headers: {
        "Content-Type": "application/grpc",
        "Cache-Control": "no-cache",
        "X-Frame-Options": "DENY",
      },
    });
  } catch (error) {
    console.error(`[V1] tunnel setup error for ${targetHost}:${targetPort}:`, error.message);
    return new Response("[V1] Tunnel connection failed", { status: 502 });
  }
}

// --- V2 Protocol Handler ---
/**
 * @param {Request} request
 * @param {string} tunnelId
 */
async function handleV2Request(request, tunnelId) {
  if (request.method === "POST") {
    // Handles the client -> target upstream data
    return handleV2Post(request, tunnelId);
  } else if (request.method === "GET") {
    // Handles the target -> client downstream data
    return handleV2Get(request, tunnelId);
  } else {
    return new Response("[V2] Method not allowed", { status: 405 });
  }
}

/**
 * @param {Request} request
 * @param {string} tunnelId
 */
async function handleV2Post(request, tunnelId) {
  // 1. Check for existing tunnel ID
  if (tunnels.has(tunnelId)) {
    return new Response("[V2] Tunnel ID already in use", { status: 409 });
  }

  // 2. Target Host
  const targetHostHeader = request.headers.get("X-Target-Host");
  if (!targetHostHeader) {
    return new Response("[V2] Missing X-Target-Host header", { status: 400 });
  }
  const targetHost = targetHostHeader.toLowerCase().trim();
  if (!/^[a-zA-Z0-9\-.:[\]]+$/.test(targetHost)) {
    return new Response("[V2] Invalid target host", { status: 400 });
  }

  // 3. Target Port
  const targetPortStr = request.headers.get("X-Target-Port");
  if (!targetPortStr) {
    return new Response("[V2] Missing X-Target-Port header", { status: 400 });
  }
  const targetPort = parseInt(targetPortStr, 10);
  if (isNaN(targetPort) || targetPort < 1 || targetPort > 65535) {
    return new Response("[V2] Invalid target port", { status: 400 });
  }

  // 4. Create a promise placeholder for the GET request to await.
  // This is key to handling the race condition where GET might arrive first.
  let resolveStream;
  let rejectStream;
  const streamPromise = new Promise((resolve, reject) => {
    resolveStream = resolve;
    rejectStream = reject;
  });
  tunnels.set(tunnelId, {
    promise: streamPromise,
    resolve: resolveStream,
    reject: rejectStream,
  });

  try {
    // 5. Connect to Target
    const socket = await Deno.connect({
      hostname: targetHost,
      port: targetPort,
    });
    console.log(`[V2] Tunnel ${tunnelId} connected to target ${targetHost}:${targetPort}`);

    // 6. Fulfill the promise, making the readable stream available to the GET handler.
    tunnels.get(tunnelId).resolve(socket.readable);

    // 7. Pipe the POST body (client->target) to the socket. Clean up on completion.
    await request.body.pipeTo(socket.writable);
    console.log(`[V2] POST stream for ${tunnelId} finished.`);

    // 8. POST is done, return 201 Created.
    return new Response("[V2] Upstream tunnel established", { status: 201 });
  } catch (error) {
    console.error(`[V2] POST setup error for ${tunnelId} (${targetHost}:${targetPort}):`, error.message);
    // If connection fails, reject the promise to notify the GET handler.
    if (tunnels.has(tunnelId)) {
      tunnels.get(tunnelId).reject(error);
    }
    return new Response("[V2] Tunnel connection failed", { status: 502 });
  }
}

/**
 * @param {Request} request
 * @param {string} tunnelId
 */
async function handleV2Get(request, tunnelId) {
  const entry = tunnels.get(tunnelId);

  // 1. Handle race condition: GET arrives before POST has created the entry.
  if (!entry) {
    // Give the POST a moment to arrive, but then fail.
    await new Promise(r => setTimeout(r, 2000));
    if (!tunnels.has(tunnelId)) {
      return new Response("[V2] Tunnel not found", { status: 404 });
    }
  }

  console.log(`[V2] GET request received for tunnel ${tunnelId}. Awaiting stream...`);
  try {
    // 2. Await the promise. This blocks until the POST handler connects to the target
    // and calls resolve() with the readable stream.
    const readableStream = await tunnels.get(tunnelId).promise;
    console.log(`[V2] GET stream for ${tunnelId} is ready.`);

    // 3. Return the stream to the client.
    return new Response(readableStream, {
      status: 200,
      headers: {
        "Content-Type": "application/grpc",
        "Cache-Control": "no-cache",
        "X-Frame-Options": "DENY",
      },
    });
  } catch (error) {
    // This block executes if the promise was rejected by the POST handler.
    console.error(`[V2] GET error for tunnel ${tunnelId}:`, error.message);
    return new Response("[V2] Tunnel failed during setup", { status: 502 });
  } finally {
    // 4. Cleanup: The tunnel is now fully closed or has failed. Remove it from the map.
    if (tunnels.has(tunnelId)) {
      console.log(`[V2] Cleaning up tunnel ${tunnelId}.`);
      tunnels.delete(tunnelId);
    }
  }
}
