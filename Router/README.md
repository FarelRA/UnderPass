# Router

Configuration-driven path router for Cloudflare Workers.

## Overview

Router is a simple, flexible routing solution that forwards requests to different backend services based on URL paths. Configuration is loaded from environment variables as JSON.

## Features

- Path-based routing
- Multiple backend support
- In-memory route caching
- Fallback route support
- Simple JSON configuration

## Configuration

Set the `CONFIG` environment variable with a JSON array of routes:

```json
[
  { "path": "/api/v1", "backend": "https://v1.api-service.com" },
  { "path": "/images", "backend": "https://image-cdn.storage.net" },
  { "path": "/", "backend": "https://main-frontend.com" }
]
```

## How It Works

1. Request comes to Router worker
2. Router matches request path against configured routes
3. Forwards request to matching backend
4. Returns backend response to client

## Route Matching

- Routes are matched in order of configuration
- First matching route wins
- Use `/` as catch-all fallback route
- More specific routes should come before general ones

## Example

```json
[
  { "path": "/api/users", "backend": "https://users-service.com" },
  { "path": "/api", "backend": "https://api-gateway.com" },
  { "path": "/", "backend": "https://frontend.com" }
]
```

Requests:
- `/api/users/123` → `https://users-service.com/api/users/123`
- `/api/posts` → `https://api-gateway.com/api/posts`
- `/about` → `https://frontend.com/about`

## Deployment

Deploy to Cloudflare Workers:

```bash
cd Cloudflare
wrangler deploy
```

Set `CONFIG` environment variable in Cloudflare dashboard or `wrangler.toml`.
