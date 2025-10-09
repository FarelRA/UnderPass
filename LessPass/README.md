# LessPass

VLESS protocol proxy with WebSocket transport for secure TCP tunneling.

## Overview

LessPass implements the VLESS protocol over WebSocket, providing authenticated TCP proxy capabilities. The server runs on Cloudflare Workers or Deno Deploy, while the client acts as a local SOCKS5 proxy.

## Features

- VLESS protocol implementation
- WebSocket transport with TLS
- TCP proxy support
- DNS-over-HTTPS (DoH) support
- UUID-based authentication
- Configurable logging levels

## Components

### Server
- **Cloudflare Workers**: Edge deployment with global reach
- **Deno Deploy**: Alternative serverless platform
- Supports TCP and UDP (DNS only on port 53)
- Configurable relay and DoH endpoints

### Client
- Go-based SOCKS5 proxy server
- Connects to LessPass server via WebSocket
- Supports IPv4, IPv6, and domain names
- Automatic VLESS header construction

## Configuration

### Server Environment Variables
- `USER_ID`: VLESS UUID for authentication
- `PASSWORD`: Password for /info endpoint
- `RELAY_ADDR`: Relay address for retry mechanism
- `DOH_URL`: DNS-over-HTTPS resolver
- `LOG_LEVEL`: Logging level (ERROR, WARN, INFO, DEBUG, TRACE)

### Client Flags
- `-server`: VLESS server WebSocket URL
- `-uuid`: VLESS user UUID
- `-local`: Local SOCKS5 proxy address (default: 127.0.0.1:1080)

## Usage

See `Client/README.md` and `Server/Cloudflare/` or `Server/Deno/` for deployment instructions.
