// Deno H2 TCP Tunnel Server

const PASSWORD = Deno.env.get("PASSWORD");
const HOSTNAME = Deno.env.get("HOSTNAME") || "0.0.0.0";
const PORT = parseInt(Deno.env.get("PORT") || "8080", 10);

const sessions = new Map();

console.log(`[*] TCP Tunnel Server starting on ${HOSTNAME}:${PORT}`);

Deno.serve({
  hostname: HOSTNAME,
  port: PORT,
  handler(request) {
    // Validate authentication
    if (request.headers.get("Authorization") !== `Basic ${PASSWORD}`) {
      return new Response("Unauthorized", { status: 401 });
    }

    const sessionId = request.headers.get("X-Session-ID");

    // V2: Decoupled streams (POST + GET)
    if (sessionId) {
      return request.method === "POST"
      ? handleUpload(request, sessionId)
      : handleDownload(request, sessionId);
    }

    // V1: Single bidirectional stream
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const { targetHost, targetPort, error } = parseTarget(request);
    if (error) return error;

    return handleLegacy(targetHost, targetPort, request.body);
  },
});

// V1: Single stream (legacy)
async function handleLegacy(targetHost, targetPort, body) {
  try {
    const socket = await Deno.connect({ hostname: targetHost, port: targetPort });
    console.log(`[<] [v1] Connected to ${targetHost}:${targetPort}`);

    body.pipeTo(socket.writable).catch(err => {
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

// V2: Upload (Client -> Target)
async function handleUpload(request, sessionId) {
  if (sessions.has(sessionId)) {
    return new Response("Session already exists", { status: 409 });
  }

  const { targetHost, targetPort, error } = parseTarget(request);
  if (error) return error;

  // Create promise for download stream
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  sessions.set(sessionId, { promise, resolve, reject });

  try {
    const socket = await Deno.connect({ hostname: targetHost, port: targetPort });
    console.log(`[<] [v2] Session ${sessionId} connected to ${targetHost}:${targetPort}`);

    // Provide readable stream to download handler
    sessions.get(sessionId).resolve(socket.readable);

    // Pipe upload stream
    await request.body.pipeTo(socket.writable);
    console.log(`[=] [v2] Upload complete for ${sessionId}`);

    return new Response(null, {
      status: 201,
      headers: {
        "Content-Type": "application/grpc",
        "Cache-Control": "no-cache",
      },
    });
  } catch (err) {
    console.error(`[!] [v2] Upload failed for ${sessionId}: ${err.message}`);
    sessions.get(sessionId)?.reject(err);
    return new Response("Connection failed", { status: 502 });
  }
}

// V2: Download (Target -> Client)
async function handleDownload(request, sessionId) {
  let entry = sessions.get(sessionId);

  // Handle race: GET arrives before POST
  if (!entry) {
    await new Promise(r => setTimeout(r, 2000));
    entry = sessions.get(sessionId);
    if (!entry) {
      return new Response("Session not found", { status: 404 });
    }
  }

  console.log(`[<] [v2] Download starting for ${sessionId}`);

  try {
    const readable = await entry.promise;
    console.log(`[=] [v2] Download ready for ${sessionId}`);

    return new Response(readable, {
      headers: {
        "Content-Type": "application/grpc",
        "Cache-Control": "no-cache",
      },
    });
  } catch (err) {
    console.error(`[!] [v2] Download failed for ${sessionId}: ${err.message}`);
    return new Response("Session failed", { status: 502 });
  } finally {
    sessions.delete(sessionId);
    console.log(`[-] [v2] Session ${sessionId} cleaned up`);
  }
}

// Helper: Parse and validate target
function parseTarget(request) {
  const targetHost = request.headers.get("X-Target-Host")?.toLowerCase().trim();
  if (!targetHost || !/^[a-zA-Z0-9\-.:[\]]+$/.test(targetHost)) {
    return { error: new Response("Invalid target host", { status: 400 }) };
  }

  const targetPort = parseInt(request.headers.get("X-Target-Port"), 10);
  if (!targetPort || targetPort < 1 || targetPort > 65535) {
    return { error: new Response("Invalid target port", { status: 400 }) };
  }

  return { targetHost, targetPort };
}
