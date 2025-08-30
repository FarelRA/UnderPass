/**
 * A simple router and load balancer for Cloudflare Workers.
 * Configured via a CONFIG environment variable.
 *
 * Example CONFIG:
 * [
 *   { "path": "/api", "backends": ["https://backend1.example.com", "https://backend2.example.com"] },
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

    // --- 2. ROUTING: Find the matching backend service ---
    const url = new URL(request.url);
    const path = url.pathname;

    // Find the first route that matches the beginning of the request path.
    // Order routes in your config from most specific to least specific.
    // e.g., `/api/users` should come before `/api`
    const route = routes.find(r => path.startsWith(r.path));
    if (!route) {
      return new Response("Route not found.", { status: 404 });
    }

    // --- 3. LOAD BALANCING: Select a backend ---
    if (!route.backends || route.backends.length === 0) {
      return new Response(`No backends configured.`, { status: 500 });
    }

    // Select a backend at random from the list.
    const randomIndex = Math.floor(Math.random() * route.backends.length);
    const backendUrlString = route.backends[randomIndex];

    // --- 4. PROXY THE REQUEST & STREAM THE RESPONSE ---
    try {
      // Create the new URL for the backend request, preserving the original path and query string.
      const backendUrl = new URL(backendUrlString);
      backendUrl.pathname = url.pathname;
      backendUrl.search = url.search;

      // Create a new Request object to forward to the backend.
      // We pass through the method, headers, and body from the original request.
      const backendRequest = new Request(backendUrl.toString(), {
        method: request.method,
        headers: request.headers,
        body: request.body,
        cache: "no-cache"
      });

      // The Cloudflare Workers runtime will stream the response from the
      // backend to the client as it arrives, without waiting for the
      // entire response to be downloaded in the worker.
      console.log(`Proxying ${request.method} ${path} to ${backendUrl.toString()}`);
      return await fetch(backendRequest);
    } catch (e) {
      console.error("Error fetching from backend:", e.message);
      return new Response(`Error connecting to backend.`, { status: 502 });
    }
  },
};
