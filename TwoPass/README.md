# TwoPass

TCP proxy tunnel over HTTP/2 for bypassing firewall restrictions.

## Overview

TwoPass provides a simple TCP proxy that tunnels connections through HTTP/2. The server accepts POST requests with target host/port headers and proxies the connection, while the client provides a local TCP listener.

## Features

- TCP tunneling over HTTP/2
- Password-based authentication
- Cloudflare Workers / Deno Deploy support
- Uses gRPC content-type to bypass Cloudflare buffering
- Bidirectional streaming

## Components

### Server
- **Cloudflare Workers**: Edge deployment with Cloudflare Sockets API
- **Deno Deploy**: Alternative serverless platform
- Accepts POST requests with authentication
- Proxies TCP connections to target host:port

### Client
- Go-based TCP proxy client
- Connects to TwoPass server via HTTP/2
- Provides local TCP listener
- Automatic authentication header injection

## Configuration

### Server Environment Variables
- `PASSWORD`: Base64-encoded password for authentication

### Client Flags
- `-server`: TwoPass server URL
- `-password`: Authentication password
- `-local`: Local TCP listener address
- `-target`: Target host:port to proxy

## Usage

See `Client/` and `Server/Cloudflare/` or `Server/Deno/` for implementation details.
