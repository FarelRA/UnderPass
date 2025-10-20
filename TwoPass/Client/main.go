// TCP tunnel client over HTTP/2 stream
package main

import (
  "context"
  "crypto/tls"
  "errors"
  "flag"
  "io"
  "log"
  "math/rand"
  "net"
  "net/http"
  "net/url"
  "strings"
  "sync"
  "time"

  "github.com/quic-go/quic-go/http3"
  "golang.org/x/net/http2"
)

// Constants for structured logging prefixes
const (
  logPrefixInfo    = "[*]"
  logPrefixSuccess = "[+]"
  logPrefixRequest = "[>]"
  logPrefixTunnel  = "[<]"
  logPrefixStream  = "[=]"
  logPrefixClose   = "[-]"
  logPrefixError   = "[!]"
)

// Config holds the client's configuration.
type Config struct {
  ListenAddr      string
  UpstreamURLPOST string // URL for POST (upload)
  UpstreamURLGET  string // URL for GET (download)
  UpstreamAddr    string
  AuthToken       string
  Version         int
}

// Proxy holds the state and configuration for our proxy server.
type Proxy struct {
  config         Config
  httpClientPOST *http.Client
  httpClientGET  *http.Client
}

// NewProxy creates and initializes a new Proxy instance.
func NewProxy(cfg Config) *Proxy {
  parsedPOST, _ := url.Parse(cfg.UpstreamURLPOST)
  parsedGET, _ := url.Parse(cfg.UpstreamURLGET)
  dialer := &net.Dialer{Timeout: 5 * time.Second}

  // Extract ports from URLs
  postPort := parsedPOST.Port()
  if postPort == "" {
    if parsedPOST.Scheme == "https" {
      postPort = "443"
    } else {
      postPort = "80"
    }
  }

  getPort := parsedGET.Port()
  if getPort == "" {
    if parsedGET.Scheme == "https" {
      getPort = "443"
    } else {
      getPort = "80"
    }
  }

  // POST client (HTTP or HTTP/2)
  var transportPOST http.RoundTripper
  if parsedPOST.Scheme == "https" {
    log.Printf("%s Configuring POST client for H2 (HTTP/2 over TLS)", logPrefixInfo)
    transportPOST = &http.Transport{
      ForceAttemptHTTP2: true,
      DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
        if cfg.UpstreamAddr != "" {
          addr = net.JoinHostPort(cfg.UpstreamAddr, postPort)
        }
        return dialer.DialContext(ctx, network, addr)
      },
      TLSClientConfig: &tls.Config{
        NextProtos:         []string{"h2"},
        InsecureSkipVerify: true,
      },
      IdleConnTimeout: 120 * time.Second,
    }
  } else {
    log.Printf("%s Configuring POST client for H2C (HTTP/2 over cleartext)", logPrefixInfo)
    transportPOST = &http2.Transport{
      AllowHTTP: true,
      DialTLSContext: func(ctx context.Context, network, addr string, _ *tls.Config) (net.Conn, error) {
        if cfg.UpstreamAddr != "" {
          addr = net.JoinHostPort(cfg.UpstreamAddr, postPort)
        } else {
          addr = parsedPOST.Host
        }
        return dialer.DialContext(ctx, network, addr)
      },
      IdleConnTimeout: 120 * time.Second,
    }
  }

  // GET client (HTTP/2 or HTTP/3)
  var transportGET http.RoundTripper
  if parsedGET.Scheme == "https" {
    log.Printf("%s Configuring GET client for H3 (HTTP/3 over QUIC)", logPrefixInfo)
    transportGET = &http3.Transport{
      TLSClientConfig: &tls.Config{
        InsecureSkipVerify: true,
      },
    }
  } else {
    log.Printf("%s Configuring GET client for H2C (HTTP/2 over cleartext)", logPrefixInfo)
    transportGET = &http2.Transport{
      AllowHTTP: true,
      DialTLSContext: func(ctx context.Context, network, addr string, _ *tls.Config) (net.Conn, error) {
        if cfg.UpstreamAddr != "" {
          addr = net.JoinHostPort(cfg.UpstreamAddr, getPort)
        } else {
          addr = parsedGET.Host
        }
        return dialer.DialContext(ctx, network, addr)
      },
      IdleConnTimeout: 120 * time.Second,
    }
  }

  return &Proxy{
    config: cfg,
    httpClientPOST: &http.Client{
      Transport: transportPOST,
    },
    httpClientGET: &http.Client{
      Transport: transportGET,
    },
  }
}

// Start runs the HTTP proxy server.
func (p *Proxy) Start() error {
  log.Printf("%s Listening for connections on: %s", logPrefixInfo, p.config.ListenAddr)
  log.Printf("%s POST (upload) to: %s", logPrefixInfo, p.config.UpstreamURLPOST)
  log.Printf("%s GET (download) from: %s", logPrefixInfo, p.config.UpstreamURLGET)
  log.Printf("%s Using protocol version: v%d", logPrefixInfo, p.config.Version)
  if p.config.UpstreamAddr != "" {
    log.Printf("%s Upstream address override is active: %s", logPrefixInfo, p.config.UpstreamAddr)
  }

  server := &http.Server{
    Addr:    p.config.ListenAddr,
    Handler: http.HandlerFunc(p.dispatchRequest),
  }

  return server.ListenAndServe()
}

// dispatchRequest directs incoming requests to the correct protocol handler.
func (p *Proxy) dispatchRequest(w http.ResponseWriter, r *http.Request) {
  log.Printf("%s Accepted connection from %s", logPrefixSuccess, r.RemoteAddr)

  if r.Method != http.MethodConnect {
    log.Printf("%s Method not allowed: %s", logPrefixError, r.Method)
    http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
    return
  }

  switch p.config.Version {
    case 1:
      p.handleConnectV1(w, r)
    case 2:
      p.handleConnectV2(w, r)
    default:
      log.Printf("%s Invalid protocol version configured: %d", logPrefixError, p.config.Version)
      http.Error(w, "Invalid internal configuration", http.StatusInternalServerError)
  }
}

// handleConnectV1 handles the logic for a CONNECT request using the original protocol.
func (p *Proxy) handleConnectV1(w http.ResponseWriter, r *http.Request) {
  log.Printf("%s [v1] Proxy request for %s", logPrefixRequest, r.Host)

  targetHost, targetPort, err := net.SplitHostPort(r.Host)
  if err != nil {
    log.Printf("%s [v1] Invalid target host format: %s", logPrefixError, r.Host)
    http.Error(w, "Invalid target host format", http.StatusBadRequest)
    return
  }
  if ip := net.ParseIP(targetHost); ip != nil && ip.To4() == nil && targetHost[0] != '[' {
    targetHost = "[" + targetHost + "]"
  }

  hijacker, _ := w.(http.Hijacker)
  clientConn, _, _ := hijacker.Hijack()
  clientConn.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n"))

  postReq, _ := http.NewRequestWithContext(r.Context(), "POST", p.config.UpstreamURLPOST, clientConn)
  p.setTunnelHeaders(postReq, targetHost, targetPort, "")

  upstreamResp, err := p.httpClientPOST.Do(postReq)
  if err != nil {
    log.Printf("%s [v1] Failed to connect to upstream: %v", logPrefixError, err)
    clientConn.Close()
    return
  }
  defer upstreamResp.Body.Close()

  if upstreamResp.StatusCode != http.StatusOK {
    log.Printf("%s [v1] Upstream returned status: %s", logPrefixError, upstreamResp.Status)
    clientConn.Close()
    return
  }
  log.Printf("%s [v1] Upstream tunnel established", logPrefixTunnel)

  written, err := io.Copy(clientConn, upstreamResp.Body)
  if err != nil && !isExpectedError(err) {
    log.Printf("%s [v1] Stream error: %v", logPrefixError, err)
  }
  log.Printf("%s [v1] Upstream -> Client copied %d bytes", logPrefixStream, written)
  clientConn.Close()

  log.Printf("%s [v1] Connection closed for %s", logPrefixClose, r.Host)
}

// handleConnectV2 handles the logic for a CONNECT request using the decoupled protocol.
func (p *Proxy) handleConnectV2(w http.ResponseWriter, r *http.Request) {
  log.Printf("%s [v2] Proxy request for %s", logPrefixRequest, r.Host)
  targetHost, targetPort, err := net.SplitHostPort(r.Host)
  if err != nil {
    http.Error(w, "Invalid target host format", http.StatusBadRequest)
    log.Printf("%s [v2] Invalid CONNECT host: %s", logPrefixError, r.Host)
    return
  }
  if ip := net.ParseIP(targetHost); ip != nil && ip.To4() == nil && targetHost[0] != '[' {
    targetHost = "[" + targetHost + "]"
  }

  hijacker, ok := w.(http.Hijacker)
  if !ok {
    http.Error(w, "Hijacking not supported", http.StatusInternalServerError)
    return
  }
  clientConn, _, err := hijacker.Hijack()
  if err != nil {
    http.Error(w, "Failed to hijack connection", http.StatusInternalServerError)
    return
  }
  clientConn.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n"))

  ctx, cancel := context.WithCancel(r.Context())
  defer cancel()

  sessionID := generateSessionID()
  log.Printf("%s [v2] Generated Session ID: %s", logPrefixInfo, sessionID)

  var wg sync.WaitGroup
  wg.Add(2)

  var closeOnce sync.Once
  tunnelClose := func() {
    clientConn.Close()
    cancel()
  }

  // POST request (client -> target)
  go func() {
    defer wg.Done()

    postReq, _ := http.NewRequestWithContext(ctx, "POST", p.config.UpstreamURLPOST, clientConn)
    p.setTunnelHeaders(postReq, targetHost, targetPort, sessionID)

    postResp, err := p.httpClientPOST.Do(postReq)
    if err != nil && !isExpectedError(err) {
      log.Printf("%s [v2] POST request failed: %v", logPrefixError, err)
      closeOnce.Do(tunnelClose)
      return
    }
    if postResp != nil {
      defer postResp.Body.Close()
      if postResp.StatusCode != http.StatusCreated {
        log.Printf("%s [v2] Upstream POST failed with status: %s", logPrefixError, postResp.Status)
        closeOnce.Do(tunnelClose)
        return
      }
      log.Printf("%s [v2] Upstream POST tunnel established", logPrefixTunnel)
    }
  }()

  // GET request (target -> client)
  go func() {
    defer wg.Done()

    getReq, _ := http.NewRequestWithContext(ctx, "GET", p.config.UpstreamURLGET, nil)
    p.setTunnelHeaders(getReq, targetHost, targetPort, sessionID)

    getResp, err := p.httpClientGET.Do(getReq)
    if err != nil && !isExpectedError(err) {
      log.Printf("%s [v2] GET request failed: %v", logPrefixError, err)
      closeOnce.Do(tunnelClose)
      return
    }
    defer getResp.Body.Close()

    if getResp.StatusCode != http.StatusOK {
      log.Printf("%s [v2] Upstream GET failed with status: %s", logPrefixError, getResp.Status)
      closeOnce.Do(tunnelClose)
      return
    }
    log.Printf("%s [v2] Upstream GET tunnel established", logPrefixTunnel)

    written, err := io.Copy(clientConn, getResp.Body)
    if err != nil && !isExpectedError(err) {
      log.Printf("%s [v2] Stream error: %v", logPrefixError, err)
    }
    log.Printf("%s [v2] Upstream -> Client copied %d bytes", logPrefixStream, written)
    closeOnce.Do(tunnelClose)
  }()

  wg.Wait()
  log.Printf("%s [v2] Connection closed for %s", logPrefixClose, r.Host)
}

// setTunnelHeaders sets common headers for tunnel requests
func (p *Proxy) setTunnelHeaders(req *http.Request, targetHost, targetPort, sessionID string) {
  req.Header.Set("Authorization", "Basic "+p.config.AuthToken)
  req.Header.Set("X-Target-Host", targetHost)
  req.Header.Set("X-Target-Port", targetPort)
  req.Header.Set("Content-Type", "application/grpc")
  if sessionID != "" {
    req.Header.Set("X-Session-ID", sessionID)
  }
}

// isExpectedError checks if an error is expected during normal cleanup
func isExpectedError(err error) bool {
  if err == nil {
    return true
  }
  return errors.Is(err, context.Canceled) ||
  errors.Is(err, net.ErrClosed) ||
  strings.Contains(err.Error(), "H3_REQUEST_CANCELLED")
}

// generateSessionID generates a random 6-character alphanumeric ID
func generateSessionID() string {
  const charset = "abcdefghijklmnopqrstuvwxyz0123456789"
  b := make([]byte, 6)
  for i := range b {
    b[i] = charset[rand.Intn(len(charset))]
  }
  return string(b)
}

func main() {
  cfg := Config{}
  flag.StringVar(&cfg.ListenAddr, "listen", "127.0.0.1:8080", "Local address for the proxy to listen on")
  flag.StringVar(&cfg.UpstreamURLPOST, "url-post", "", "URL for POST/upload (e.g., http://server.com/tunnel)")
  flag.StringVar(&cfg.UpstreamURLGET, "url-get", "", "URL for GET/download (e.g., https://server.com/tunnel)")
  flag.StringVar(&cfg.UpstreamAddr, "addr", "", "Override IP address for the upstream server (e.g., 1.2.3.4)")
  flag.StringVar(&cfg.AuthToken, "token", "", "Authentication token for the upstream server")
  flag.IntVar(&cfg.Version, "version", 2, "Protocol version to use (1 or 2)")
  flag.Parse()

  if cfg.UpstreamURLPOST == "" || cfg.UpstreamURLGET == "" || cfg.AuthToken == "" {
    flag.Usage()
    log.Fatalf("%s Upstream URLs and Authentication token are required.", logPrefixError)
  }

  if cfg.Version != 1 && cfg.Version != 2 {
    log.Fatalf("%s Invalid protocol version specified. Must be 1 or 2.", logPrefixError)
  }

  log.Printf("%s HTTP proxy server starting...", logPrefixInfo)
  proxy := NewProxy(cfg)
  if err := proxy.Start(); err != nil {
    log.Fatalf("%s Failed to start proxy server: %v", logPrefixError, err)
  }
}
