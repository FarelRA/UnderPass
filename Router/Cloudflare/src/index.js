/**
 * A simple, configuration-driven router for Cloudflare Workers.
 * Configuration is loaded from the CONFIG environment variable as a JSON array.
 *
 * CONFIG Example (JSON String):
 * [
 * { "path": "/api/v1", "backend": "https://v1.api-service.com" },
 * { "path": "/images", "backend": "https://image-cdn.storage.net" },
 * { "path": "/", "backend": "https://main-frontend.com" }
 * ]
 */

export default {
  /**
   * Caches the parsed routes after the first request.
   * This is a simple in-memory cache for the Worker instance's lifetime.
   */
  routes: null,

  /**
   * Initializes and validates the routes configuration from the environment variables.
   * @param {object} env The environment variables object.
   * @returns {Array<object>|null} The parsed routes or null on failure.
   */
  getRoutes(env) {
    if (this.routes) {
      return this.routes; // Use cached routes
    }

    try {
      const parsedRoutes = JSON.parse(env.CONFIG);
      if (!Array.isArray(parsedRoutes)) {
        throw new Error("CONFIG must be a JSON array of route objects.");
      }
      // Basic validation: ensure all routes have path and backend
      const validRoutes = parsedRoutes.filter(r => r.path && r.backend);

      // Cache and return valid routes
      this.routes = validRoutes;
      return this.routes;
    } catch (e) {
      console.error("Invalid CONFIG:", e.message);
      return null;
    }
  },

  /**
   * Handles the incoming request.
   * @param {Request} request The incoming Request object.
   * @param {object} env The environment variables object.
   */
  async fetch(request, env) {
    const routes = this.getRoutes(env);

    if (!routes) {
      return new Response("Configuration error: Check CONFIG variable.", { status: 500 });
    }

    const { pathname, search } = new URL(request.url);

    // --- 1. ROUTING: Find the matching backend service ---
    // Find the first route that matches the path prefix.
    const route = routes.find(r => pathname.startsWith(r.path));

    if (!route) {
      return new Response("Route not found.", { status: 404 });
    }

    // --- 2. PROXY THE REQUEST ---
    try {
      // Destructure path and backend from the matched route
      const { path: routePrefix, backend: backendUrlString } = route;
      const backendUrl = new URL(backendUrlString);

      // Construct the new path: remove the matched prefix and join with backend path
      // 2a. Get the remaining path part (e.g., /users/123)
      const remainingPath = pathname.substring(routePrefix.length);

      // 2b. Combine paths and clean up potential double slashes
      const combinedPath = [backendUrl.pathname, remainingPath].join('/').replace(/\/\/+/g, '/');
      backendUrl.pathname = combinedPath;

      // 2c. Preserve the original query string
      backendUrl.search = search;

      // Create a new Request and forward it. The original 'request' is passed
      // as the second argument to inherit method, headers, and body.
      const backendRequest = new Request(backendUrl.toString(), request);

      return await fetch(backendRequest);
    } catch (e) {
      console.error(`Error proxying to backend ${route.backend}:`, e.message);
      return new Response("Error connecting to upstream backend.", { status: 502 });
    }
  },
};
