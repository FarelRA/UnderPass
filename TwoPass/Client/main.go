// TCP tunnel client over HTTP/2 stream
package main

import (
  "context"
  "crypto/tls"
  "errors"
  "flag"
  "io"
  "log"
  "net"
  "net/http"
  "net/url"
  "sync"
  "time"

  "github.com/google/uuid"
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

  // POST client (HTTP or HTTP/2)
  var transportPOST http.RoundTripper
  if parsedPOST.Scheme == "https" {
    log.Printf("%s Configuring POST client for H2 (HTTP/2 over TLS)", logPrefixInfo)
    transportPOST = &http.Transport{
      ForceAttemptHTTP2: true,
      DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
        if cfg.UpstreamAddr != "" {
          addr = cfg.UpstreamAddr
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
          addr = cfg.UpstreamAddr
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
          addr = cfg.UpstreamAddr
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

  reqReader, reqWriter := io.Pipe()
  postReq, _ := http.NewRequestWithContext(r.Context(), "POST", p.config.UpstreamURLPOST, reqReader)
  postReq.Header.Set("Authorization", "Basic "+p.config.AuthToken)
  postReq.Header.Set("X-Target-Host", targetHost)
  postReq.Header.Set("X-Target-Port", targetPort)
  postReq.Header.Set("Content-Type", "application/grpc")

  upstreamResp, err := p.httpClientPOST.Do(postReq)
  if err != nil {
    log.Printf("%s [v1] Failed to connect to upstream: %v", logPrefixError, err)
    http.Error(w, "Failed to connect to upstream server", http.StatusBadGateway)
    return
  }

  if upstreamResp.StatusCode != http.StatusOK {
    upstreamResp.Body.Close()
    log.Printf("%s [v1] Upstream returned status: %s", logPrefixError, upstreamResp.Status)
    http.Error(w, "Upstream server failed to connect to target", http.StatusBadGateway)
    return
  }
  log.Printf("%s [v1] Tunnel established to upstream", logPrefixTunnel)

  hijacker, _ := w.(http.Hijacker)
  clientConn, _, _ := hijacker.Hijack()
  clientConn.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n"))

  var wg sync.WaitGroup
  wg.Add(2)
  go func() {
    defer wg.Done()
    written, err := io.Copy(reqWriter, clientConn)
    log.Printf("%s [v1] Client -> Upstream stream copied %d bytes", logPrefixStream, written)
    if err != nil && !errors.Is(err, net.ErrClosed) {
      log.Printf("%s [v1] Client -> Upstream stream error: %v", logPrefixError, err)
    }
    reqWriter.Close()
  }()
  go func() {
    defer wg.Done()
    written, err := io.Copy(clientConn, upstreamResp.Body)
    log.Printf("%s [v1] Upstream -> Client stream copied %d bytes", logPrefixStream, written)
    if err != nil && !errors.Is(err, net.ErrClosed) {
      log.Printf("%s [v1] Upstream -> Client stream error: %v", logPrefixError, err)
    }
    clientConn.Close()
  }()
  wg.Wait()

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

  sessionID := uuid.New().String()
  log.Printf("%s [v2] Generated Session ID: %s", logPrefixInfo, sessionID)

  var wg sync.WaitGroup
  wg.Add(2)

  var closeOnce sync.Once
  tunnelClose := func() {
    clientConn.Close()
    cancel()
  }

  // POST request (client -> target)
  postPipeR, postPipeW := io.Pipe()
  go func() {
    defer wg.Done()
    defer postPipeW.Close()
    written, err := io.Copy(postPipeW, clientConn)
    log.Printf("%s [v2] Client -> Upstream stream copied %d bytes", logPrefixStream, written)
    if err != nil && !errors.Is(err, net.ErrClosed) {
      log.Printf("%s [v2] Client -> Upstream stream error: %v", logPrefixError, err)
    }
    closeOnce.Do(tunnelClose)
  }()

  go func() {
    postReq, _ := http.NewRequestWithContext(ctx, "POST", p.config.UpstreamURLPOST, postPipeR)
    postReq.Header.Set("Authorization", "Basic "+p.config.AuthToken)
    postReq.Header.Set("X-Target-Host", targetHost)
    postReq.Header.Set("X-Target-Port", targetPort)
    postReq.Header.Set("X-Session-ID", sessionID)
    postReq.Header.Set("Content-Type", "application/grpc")

    postResp, err := p.httpClientPOST.Do(postReq)
    if err != nil {
      log.Printf("%s [v2] POST request failed: %v", logPrefixError, err)
      closeOnce.Do(tunnelClose)
      return
    }
    defer postResp.Body.Close()
    io.Copy(io.Discard, postResp.Body)
    if postResp.StatusCode != http.StatusCreated {
      log.Printf("%s [v2] Upstream POST failed with status: %s", logPrefixError, postResp.Status)
      closeOnce.Do(tunnelClose)
    }
    log.Printf("%s [v2] Upstream POST tunnel established", logPrefixTunnel)
  }()

  // GET request (target -> client)
  go func() {
    defer wg.Done()

    getReq, _ := http.NewRequestWithContext(ctx, "GET", p.config.UpstreamURLGET, nil)
    getReq.Header.Set("Authorization", "Basic "+p.config.AuthToken)
    getReq.Header.Set("X-Target-Host", targetHost)
    getReq.Header.Set("X-Target-Port", targetPort)
    getReq.Header.Set("X-Session-ID", sessionID)
    getReq.Header.Set("Content-Type", "application/grpc")

    getResp, err := p.httpClientGET.Do(getReq)
    if err != nil {
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
    log.Printf("%s [v2] Upstream GET tunnel established, beginning stream.", logPrefixTunnel)

    written, err := io.Copy(clientConn, getResp.Body)
    log.Printf("%s [v2] Upstream -> Client stream copied %d bytes", logPrefixStream, written)
    if err != nil && !errors.Is(err, net.ErrClosed) {
      log.Printf("%s [v2] Upstream -> Client stream error: %v", logPrefixError, err)
    }
    closeOnce.Do(tunnelClose)
  }()

  wg.Wait()
  log.Printf("%s [v2] Connection closed for %s", logPrefixClose, r.Host)
}

func main() {
  cfg := Config{}
  flag.StringVar(&cfg.ListenAddr, "listen", "127.0.0.1:8080", "Local address for the proxy to listen on")
  flag.StringVar(&cfg.UpstreamURLPOST, "url-post", "", "URL for POST/upload (e.g., http://server.com/tunnel)")
  flag.StringVar(&cfg.UpstreamURLGET, "url-get", "", "URL for GET/download (e.g., https://server.com/tunnel)")
  flag.StringVar(&cfg.UpstreamAddr, "addr", "", "Override address for the upstream server (e.g., 127.0.0.1:8443)")
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
