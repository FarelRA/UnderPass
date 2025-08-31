/**
 * A simple router and load balancer for Cloudflare Workers that supports both
 * HTTP and WebSocket proxying.
 *
 * Configured via a CONFIG environment variable.
 *
 * Example CONFIG:
 * [
 *   { "path": "/api/ws", "backends": ["https://ws-backend1.example.com", "https://ws-backend2.example.com"] },
 *   { "path": "/api", "backends": ["https://api-backend.example.com"] },
 *   { "path": "/", "backends": ["https://frontend.example.com"] }
 * ]
 */

export default {
  async fetch(request, env) {
    // --- 1. PARSE CONFIGURATION ---
    let routes;
    try {
      routes = JSON.parse(env.CONFIG);
      if (!Array.isArray(routes)) {
        throw new Error("CONFIG must be a JSON array of route objects.");
      }
    } catch (e) {
      console.error("Invalid CONFIG:", e.message);
      return new Response(`Failed to parse config.`, { status: 500 });
    }

    // --- 2. ROUTING ---
    const url = new URL(request.url);
    const path = url.pathname;
    const search = url.search;

    const route = routes.find(r => path.startsWith(r.path));
    if (!route) {
      return new Response("Route not found.", { status: 404 });
    }

    // --- 3. LOAD BALANCING ---
    if (!route.backends || route.backends.length === 0) {
      return new Response(`No backends configured for this route.`, { status: 500 });
    }

    const randomIndex = Math.floor(Math.random() * route.backends.length);
    const backendUrlString = route.backends[randomIndex];

    // --- 4. DISPATCH TO PROXY HANDLER ---
    try {
      // Construct the full backend URL, stripping the route prefix
      const backendUrl = new URL(backendUrlString);
      const remainingPath = path.substring(route.path.length);
      const combinedPath = [backendUrl.pathname, remainingPath].join('/').replace(/\/+/g, '/');
      backendUrl.pathname = combinedPath;
      backendUrl.search = search;

      // Decide which proxy handler to use based on the Upgrade header
      if (request.headers.get("Upgrade") === "websocket") {
        return await handleWebSocketProxy(request, backendUrl);
      } else {
        return await handleHTTPProxy(request, backendUrl);
      }

    } catch (e) {
      console.error("Error in proxy handler:", e.message);
      return new Response(`Error connecting to backend.`, { status: 502 });
    }
  },
};

async function handleHTTPProxy(request, backendUrl) {
  // Create a new request to forward to the backend
  const backendRequest = new Request(backendUrl.toString(), {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect: "manual",
  });

  // Fetch the response from the backend
  const backendResponse = await fetch(backendRequest);

  // Return the backend's response directly to the client
  return new Response(backendResponse.body, backendResponse);
}

async function handleWebSocketProxy(request, backendUrl) {
  // Create a WebSocket pair: one for the client, one for our worker
  const [clientSocket, serverSocket] = Object.values(new WebSocketPair());

  // Change the backend URL protocol from http(s) to ws(s)
  const wsBackendUrl = new URL(backendUrl);
  wsBackendUrl.protocol = wsBackendUrl.protocol.replace('http', 'ws');

  // Establish the WebSocket connection to the backend
  const backendResponse = await fetch(wsBackendUrl.toString(), {
    headers: request.headers, // Forward original headers
  });

  // If the backend fails the upgrade, return an error
  if (backendResponse.status !== 101) {
    console.error(`Backend failed to upgrade for ${wsBackendUrl.toString()}:`, backendResponse.status, backendResponse.statusText);
    const body = await backendResponse.text();
    return new Response(`Backend connection error: ${body}`, {
      status: backendResponse.status,
      statusText: backendResponse.statusText,
    });
  }

  const backendSocket = backendResponse.webSocket;
  if (!backendSocket) {
    return new Response('Backend did not return a WebSocket', { status: 502 });
  }

  // Set up the proxying logic
  serverSocket.accept();
  backendSocket.accept();

  // Forward messages from client to backend
  serverSocket.addEventListener('message', event => {
    backendSocket.send(event.data);
  });

  // Forward messages from backend to client
  backendSocket.addEventListener('message', event => {
    serverSocket.send(event.data);
  });

  // Handle connection closures
  const closeOrErrorHandler = () => {
    if (backendSocket.readyState !== WebSocket.READY_STATE_CLOSED) {
      backendSocket.close(1000, 'Client disconnected');
    }
    if (serverSocket.readyState !== WebSocket.READY_STATE_CLOSED) {
      serverSocket.close(1000, 'Backend disconnected');
    }
  };
  serverSocket.addEventListener('close', closeOrErrorHandler);
  serverSocket.addEventListener('error', closeOrErrorHandler);
  backendSocket.addEventListener('close', closeOrErrorHandler);
  backendSocket.addEventListener('error', closeOrErrorHandler);

  // Return the client-side socket to the browser to complete the handshake
  return new Response(null, {
    status: 101,
    webSocket: clientSocket,
  });
}
