# TwoPass

High-performance TCP-over-HTTP/2 tunnel for bypassing firewall restrictions with dual protocol support.

## Overview

TwoPass provides a robust TCP proxy that tunnels connections through HTTP/2 and HTTP/3 streams. The system supports two protocol versions:

- **V1**: Single bidirectional HTTP/2 POST stream (simpler, lower latency)
- **V2**: Decoupled POST (upload) and GET (download) streams with session management (more flexible, supports HTTP/3)

## Features

- 🚀 **Dual Protocol Support**: V1 (bidirectional) and V2 (decoupled streams)
- 🔒 **Secure**: Token-based authentication, TLS support
- ⚡ **High Performance**: Zero-copy streaming, 128KB buffers, connection pooling
- 🌐 **Multi-Platform**: Cloudflare Workers (edge) and Deno Deploy (serverless)
- 📊 **Structured Logging**: Request IDs, symmetric log prefixes
- 🛡️ **Robust**: Comprehensive error handling, automatic cleanup, session TTL
- 🔧 **Configurable**: Timeouts, TLS verification, address override

## Architecture

### V1 Protocol (Bidirectional)
```
Client ←→ HTTP/2 POST (bidirectional) ←→ Server ←→ Target
```
- Single POST request with request body as upload stream
- Response body as download stream
- Lower latency, simpler implementation
- Uses `ctx.waitUntil()` (Cloudflare) to keep upload alive

### V2 Protocol (Decoupled)
```
Client → HTTP/2 POST (upload) → Server → Target
Client ← HTTP/3 GET (download) ← Server ← Target
```
- Separate POST and GET requests sharing session ID
- POST sends data from client to target
- GET receives data from target to client
- Supports HTTP/3 (QUIC) for download stream
- Session-based with automatic TTL cleanup (60s)

## Components

### Client (Go)
- Local HTTP CONNECT proxy
- HTTP/2 for POST, HTTP/3 for GET (V2)
- Multi-architecture support (ARMv7, ARMv8, x86, x86_64)
- Configurable timeouts and TLS verification

### Server (Cloudflare Workers)
- Edge deployment with Durable Objects for V2 sessions
- Automatic session eviction (~30s idle)
- Structured logging with request IDs
- Comprehensive input validation

### Server (Deno Deploy)
- Alternative serverless platform
- Session TTL management (60s)
- Symmetric behavior with Cloudflare
- Native HTTP/2 support

## Installation

### Client

**Pre-built binaries:**
```bash
# Download from releases
wget https://github.com/FarelRA/UnderPass/releases/latest/download/twopass-x86_64
chmod +x twopass-x86_64
```

**Build from source:**
```bash
cd Client
make              # Build all architectures
make verify       # Verify checksums
```

### Server (Cloudflare Workers)

```bash
cd Server/Cloudflare
npm install
wrangler secret put PASSWORD  # Set authentication token
wrangler deploy
```

### Server (Deno Deploy)

```bash
cd Server/Deno
# Set PASSWORD environment variable in Deno Deploy dashboard
deployctl deploy --project=your-project src/index.js
```

## Usage

### Client Flags

```
-listen string
    Local address for the proxy to listen on (default "127.0.0.1:8080")

-url string
    URL for both POST and GET (shorthand)

-url-post string
    URL for POST/upload (e.g., https://server.com/tunnel)

-url-get string
    URL for GET/download (e.g., https://server.com/tunnel)

-addr string
    Override IP address for the upstream server (e.g., 1.2.3.4)

-token string
    Authentication token for the upstream server (required)

-version int
    Protocol version to use: 1 or 2 (default 2)

-insecure
    Skip TLS certificate verification (default true)

-conn-timeout duration
    Connection timeout (default 10s)

-stream-timeout duration
    Stream timeout, 0 = no timeout (default 0)

-v  Show version
```

### Examples

**V1 Protocol (Bidirectional):**
```bash
./twopass-x86_64 \
  -version 1 \
  -url https://tunnel.example.com/proxy \
  -token "your-secret-token" \
  -listen 127.0.0.1:8080
```

**V2 Protocol (Decoupled, HTTP/3):**
```bash
./twopass-x86_64 \
  -version 2 \
  -url https://tunnel.example.com/proxy \
  -token "your-secret-token" \
  -listen 127.0.0.1:8080
```

**With IP Override (bypass DNS):**
```bash
./twopass-x86_64 \
  -version 2 \
  -url https://tunnel.example.com/proxy \
  -addr 172.67.156.86 \
  -token "your-secret-token"
```

**Configure as system proxy:**
```bash
export HTTP_PROXY=http://127.0.0.1:8080
export HTTPS_PROXY=http://127.0.0.1:8080
curl https://example.com  # Traffic goes through tunnel
```

### Server Configuration

**Cloudflare Workers:**
```toml
# wrangler.toml
name = "twopass"
main = "src/index.js"
compatibility_date = "2025-10-20"

[durable_objects]
bindings = [
  { name = "TCP_SESSION", class_name = "TCPSession" }
]

[[migrations]]
tag = "v1"
new_sqlite_classes = ["TCPSession"]
```

**Environment Variables:**
- `PASSWORD`: Authentication token (set via `wrangler secret put PASSWORD`)

**Deno Deploy:**
- `PASSWORD`: Authentication token (set in dashboard)
- `HOSTNAME`: Listen hostname (default: "0.0.0.0")
- `PORT`: Listen port (default: 8080)

## Authentication

The client sends the token as a `Basic` authentication header:
```
Authorization: Basic <your-token>
```

**Note**: The token is sent as-is (not Base64 encoded). The server compares it directly with the `PASSWORD` environment variable.

## Security Considerations

### Best Practices

1. **Use Strong Tokens**: Generate cryptographically random tokens
   ```bash
   openssl rand -base64 32
   ```

2. **Enable TLS**: Always use HTTPS URLs in production
   ```bash
   -url https://tunnel.example.com/proxy
   ```

3. **Verify Certificates**: Disable `-insecure` in production
   ```bash
   -insecure=false
   ```

4. **Limit Exposure**: Bind client to localhost only
   ```bash
   -listen 127.0.0.1:8080  # Not 0.0.0.0:8080
   ```

5. **Monitor Logs**: Watch for unauthorized access attempts
   ```
   [!] Unauthorized request
   [!] Invalid target host: ...
   ```

### Validation

Both servers validate:
- **Authentication**: Token must match `PASSWORD` env var
- **Target Host**: Must be valid domain/IPv4/IPv6 format
- **Target Port**: Must be 1-65535
- **Request Method**: V1 requires POST, V2 requires POST/GET with session ID

## Troubleshooting

### Client Issues

**"Failed to connect to upstream"**
- Check server URL is correct and accessible
- Verify token matches server `PASSWORD`
- Test with `curl -v https://your-server.com/tunnel`

**"Hijacking not supported"**
- HTTP/1.1 CONNECT required from client application
- Some clients don't support CONNECT method

**"TLS handshake timeout"**
- Increase `-conn-timeout` (default 10s)
- Check network connectivity to server
- Verify server is responding

**"Stream error: context canceled"**
- Normal cleanup message, can be ignored
- Indicates connection closed gracefully

### Server Issues

**"Invalid target host"**
- Target must be valid domain, IPv4, or IPv6
- IPv6 must be in brackets: `[2001:db8::1]`
- No special characters except dots, hyphens, colons, brackets

**"Connection failed"**
- Server cannot reach target host/port
- Check target is accessible from server
- Verify firewall rules allow outbound connections

**Cloudflare: "Durable Object not found"**
- Run migrations: `wrangler deploy`
- Check `wrangler.toml` has correct DO configuration

**Deno: "Session expired"**
- V2 sessions expire after 60s of inactivity
- Client should reconnect automatically
- Check client logs for reconnection attempts

### Performance Issues

**High latency:**
- Use V1 protocol for lower latency (single stream)
- Check network path to server
- Consider edge deployment (Cloudflare Workers)

**Low throughput:**
- V2 uses 128KB buffers by default
- Check server has sufficient bandwidth
- Monitor server CPU/memory usage

**Connection drops:**
- Increase `-stream-timeout` if needed
- Check for network instability
- Review server logs for errors

## Development

### Building

```bash
cd Client
make clean
make              # Build all architectures
make verify       # Verify checksums
```

### Testing

```bash
# Start server locally (Deno)
cd Server/Deno
PASSWORD=test deno run --allow-net --allow-env src/index.js

# Start client
cd Client
./dist/twopass-x86_64 -version 1 -url http://localhost:8080/tunnel -token test

# Test connection
curl -x http://127.0.0.1:8080 https://example.com
```

### Logging

All components use symmetric logging prefixes:
- `[*]` Info
- `[+]` Success
- `[>]` Request
- `[<]` Tunnel established
- `[=]` Stream activity
- `[-]` Close/cleanup
- `[!]` Error

V1 uses random 8-char request IDs, V2 uses 6-char session IDs.

## Performance

### Benchmarks

- **Latency**: V1 ~50ms, V2 ~100ms (additional round-trip)
- **Throughput**: Up to 100 Mbps per connection (network dependent)
- **Connections**: 100+ concurrent connections supported
- **Memory**: ~10MB per 100 connections (client), minimal (servers)

### Optimization

- Use V1 for latency-sensitive applications
- Use V2 for HTTP/3 support and flexibility
- Enable connection pooling (automatic)
- Use edge deployment for global low latency

## License

See repository for license information.

## Contributing

Contributions welcome! Please ensure:
- Code follows existing style
- All tests pass
- Documentation is updated
- Commit messages are descriptive

## Support

For issues, questions, or feature requests, please open an issue on GitHub.
