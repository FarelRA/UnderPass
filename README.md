# UnderPass

Collection of network tunneling and proxy solutions deployed on Cloudflare Workers and Deno.

## Projects

### LessPass
VLESS protocol proxy with WebSocket transport.
- **Server**: Cloudflare Workers / Deno Deploy
- **Client**: Go SOCKS5 proxy
- **Protocol**: VLESS over WebSocket
- **Use case**: TCP proxy with authentication

### TwoPass
TCP proxy tunnel over HTTP/2.
- **Server**: Cloudflare Workers / Deno Deploy  
- **Client**: Go TCP proxy
- **Protocol**: Custom TCP over HTTP/2
- **Use case**: Bypass firewall restrictions

### Conduit
Permissive CORS proxy for API requests.
- **Server**: Cloudflare Workers
- **Use case**: Cross-origin API access

### Router
Configuration-driven path router.
- **Server**: Cloudflare Workers
- **Use case**: Route requests to multiple backends

## Structure

```
underpass/
├── LessPass/          # VLESS proxy (Client + Server)
├── TwoPass/           # TCP proxy (Client + Server)
├── Conduit/           # CORS proxy (Server only)
└── Router/            # Path router (Server only)
```

## Deployment

Each server can be deployed to:
- **Cloudflare Workers**: `wrangler deploy`
- **Deno Deploy**: `deployctl deploy`

See individual project READMEs for details.
