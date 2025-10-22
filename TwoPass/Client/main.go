// TCP tunnel client over HTTP/2 stream
package main

import (
  "context"
  "crypto/tls"
  "errors"
  "flag"
  "fmt"
  "io"
  "log"
  "math/rand"
  "net"
  "net/http"
  "net/url"
  "strings"
  "sync"
  "time"

  "github.com/quic-go/quic-go"
  "github.com/quic-go/quic-go/http3"
  "golang.org/x/net/http2"
)

// Version is set via ldflags during build
var Version = "dev"

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
  ListenAddr         string
  UpstreamAddr       string
  UpstreamURLPOST    string
  UpstreamURLGET     string
  HTTPVersionPOST    string
  HTTPVersionGET     string
  AuthToken          string
  ConnTimeout        time.Duration
  StreamTimeout      time.Duration
  InsecureSkipVerify bool
  Version            int
}

// Proxy holds the state and configuration for our proxy server.
type Proxy struct {
  config         Config
  httpClientPOST *http.Client
  httpClientGET  *http.Client
}

// NewProxy creates and initializes a new Proxy instance.
func NewProxy(cfg Config) (*Proxy, error) {
  parsedPOST, err := url.Parse(cfg.UpstreamURLPOST)
  if err != nil {
    return nil, fmt.Errorf("invalid POST URL: %w", err)
  }
  parsedGET, err := url.Parse(cfg.UpstreamURLGET)
  if err != nil {
    return nil, fmt.Errorf("invalid GET URL: %w", err)
  }

  dialer := &net.Dialer{Timeout: cfg.ConnTimeout}

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

  // POST client configuration based on HTTPVersion
  var transportPOST http.RoundTripper
  httpVersion := cfg.HTTPVersionPOST
  if httpVersion == "" || httpVersion == "auto" {
    if parsedPOST.Scheme == "https" {
      httpVersion = "h2"
    } else {
      httpVersion = "h2c"
    }
  }

  switch httpVersion {
  case "h3":
    log.Printf("%s Configuring POST client for H3 (HTTP/3 over QUIC)", logPrefixInfo)
    h3Transport := &http3.Transport{
      TLSClientConfig: &tls.Config{
        InsecureSkipVerify: cfg.InsecureSkipVerify,
      },
    }
    if cfg.UpstreamAddr != "" {
      h3Transport.Dial = func(ctx context.Context, addr string, tlsCfg *tls.Config, quicCfg *quic.Config) (*quic.Conn, error) {
        udpAddr, err := net.ResolveUDPAddr("udp", net.JoinHostPort(cfg.UpstreamAddr, postPort))
        if err != nil {
          return nil, err
        }
        return quic.DialAddr(ctx, udpAddr.String(), tlsCfg, quicCfg)
      }
    }
    transportPOST = h3Transport
  case "h2":
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
        InsecureSkipVerify: cfg.InsecureSkipVerify,
      },
      MaxIdleConns:        100,
      MaxIdleConnsPerHost: 10,
      MaxConnsPerHost:     10,
      IdleConnTimeout:     120 * time.Second,
    }
  case "h2c":
    log.Printf("%s Configuring POST client for H2C (HTTP/2 over cleartext)", logPrefixInfo)
    transportPOST = &http2.Transport{
      AllowHTTP: true,
      DialTLSContext: func(ctx context.Context, network, addr string, _ *tls.Config) (net.Conn, error) {
        if cfg.UpstreamAddr != "" {
          addr = net.JoinHostPort(cfg.UpstreamAddr, postPort)
        } else {
          addr = net.JoinHostPort(parsedPOST.Hostname(), postPort)
        }
        return dialer.DialContext(ctx, network, addr)
      },
      IdleConnTimeout: 120 * time.Second,
    }
  }

  // GET client configuration for V2
  var transportGET http.RoundTripper
  if cfg.Version == 2 {
    getHTTPVersion := cfg.HTTPVersionGET
    if getHTTPVersion == "" || getHTTPVersion == "auto" {
      if parsedGET.Scheme == "https" {
        getHTTPVersion = "h3"
      } else {
        getHTTPVersion = "h2c"
      }
    }

    switch getHTTPVersion {
    case "h3":
      log.Printf("%s Configuring GET client for H3 (HTTP/3 over QUIC)", logPrefixInfo)
      h3Transport := &http3.Transport{
        TLSClientConfig: &tls.Config{
          InsecureSkipVerify: cfg.InsecureSkipVerify,
        },
      }
      if cfg.UpstreamAddr != "" {
        h3Transport.Dial = func(ctx context.Context, addr string, tlsCfg *tls.Config, quicCfg *quic.Config) (*quic.Conn, error) {
          udpAddr, err := net.ResolveUDPAddr("udp", net.JoinHostPort(cfg.UpstreamAddr, getPort))
          if err != nil {
            return nil, err
          }
          return quic.DialAddr(ctx, udpAddr.String(), tlsCfg, quicCfg)
        }
      }
      transportGET = h3Transport
    case "h2":
      log.Printf("%s Configuring GET client for H2 (HTTP/2 over TLS)", logPrefixInfo)
      transportGET = &http.Transport{
        ForceAttemptHTTP2: true,
        DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
          if cfg.UpstreamAddr != "" {
            addr = net.JoinHostPort(cfg.UpstreamAddr, getPort)
          }
          return dialer.DialContext(ctx, network, addr)
        },
        TLSClientConfig: &tls.Config{
          NextProtos:         []string{"h2"},
          InsecureSkipVerify: cfg.InsecureSkipVerify,
        },
        MaxIdleConns:        100,
        MaxIdleConnsPerHost: 10,
        MaxConnsPerHost:     10,
        IdleConnTimeout:     120 * time.Second,
      }
    case "h2c":
      log.Printf("%s Configuring GET client for H2C (HTTP/2 over cleartext)", logPrefixInfo)
      transportGET = &http2.Transport{
        AllowHTTP: true,
        DialTLSContext: func(ctx context.Context, network, addr string, _ *tls.Config) (net.Conn, error) {
          if cfg.UpstreamAddr != "" {
            addr = net.JoinHostPort(cfg.UpstreamAddr, getPort)
          } else {
            addr = net.JoinHostPort(parsedGET.Hostname(), getPort)
          }
          return dialer.DialContext(ctx, network, addr)
        },
        IdleConnTimeout: 120 * time.Second,
      }
    }
  }

  return &Proxy{
    config: cfg,
    httpClientPOST: &http.Client{
      Transport: transportPOST,
      Timeout:   0, // No timeout for streaming
    },
    httpClientGET: &http.Client{
      Transport: transportGET,
      Timeout:   0, // No timeout for streaming
    },
  }, nil
}

// Start runs the HTTP proxy server.
func (p *Proxy) Start() error {
  log.Printf("%s Listening for connections on: %s", logPrefixInfo, p.config.ListenAddr)
  if p.config.Version == 1 {
    log.Printf("%s Tunnel URL: %s", logPrefixInfo, p.config.UpstreamURLPOST)
  } else {
    log.Printf("%s POST (upload) to: %s", logPrefixInfo, p.config.UpstreamURLPOST)
    log.Printf("%s GET (download) from: %s", logPrefixInfo, p.config.UpstreamURLGET)
  }
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

  hijacker, ok := w.(http.Hijacker)
  if !ok {
    log.Printf("%s [v1] Hijacking not supported", logPrefixError)
    http.Error(w, "Hijacking not supported", http.StatusInternalServerError)
    return
  }

  clientConn, _, err := hijacker.Hijack()
  if err != nil {
    log.Printf("%s [v1] Failed to hijack connection: %v", logPrefixError, err)
    http.Error(w, "Failed to hijack connection", http.StatusInternalServerError)
    return
  }
  defer clientConn.Close()

  if p.config.StreamTimeout > 0 {
    clientConn.SetDeadline(time.Now().Add(p.config.StreamTimeout))
  }

  _, err = clientConn.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n"))
  if err != nil {
    log.Printf("%s [v1] Failed to write CONNECT response: %v", logPrefixError, err)
    return
  }

  ctx := r.Context()
  if p.config.StreamTimeout > 0 {
    var cancel context.CancelFunc
    ctx, cancel = context.WithTimeout(ctx, p.config.StreamTimeout)
    defer cancel()
  }

  postReq, err := http.NewRequestWithContext(ctx, "POST", p.config.UpstreamURLPOST, clientConn)
  if err != nil {
    log.Printf("%s [v1] Failed to create POST request: %v", logPrefixError, err)
    return
  }
  p.setTunnelHeaders(postReq, targetHost, targetPort, "")

  upstreamResp, err := p.httpClientPOST.Do(postReq)
  if err != nil {
    log.Printf("%s [v1] Failed to connect to upstream: %v", logPrefixError, err)
    return
  }
  defer upstreamResp.Body.Close()

  if upstreamResp.StatusCode != http.StatusOK {
    log.Printf("%s [v1] Upstream returned status: %s", logPrefixError, upstreamResp.Status)
    return
  }
  log.Printf("%s [v1] Upstream tunnel established", logPrefixTunnel)

  buf := make([]byte, 128*1024)
  _, err = io.CopyBuffer(clientConn, upstreamResp.Body, buf)
  if err != nil && !isExpectedError(err) {
    log.Printf("%s [v1] Stream error: %v", logPrefixError, err)
  }

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
    log.Printf("%s [v2] Hijacking not supported", logPrefixError)
    http.Error(w, "Hijacking not supported", http.StatusInternalServerError)
    return
  }
  clientConn, _, err := hijacker.Hijack()
  if err != nil {
    log.Printf("%s [v2] Failed to hijack connection: %v", logPrefixError, err)
    http.Error(w, "Failed to hijack connection", http.StatusInternalServerError)
    return
  }

  if p.config.StreamTimeout > 0 {
    clientConn.SetDeadline(time.Now().Add(p.config.StreamTimeout))
  }

  _, err = clientConn.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n"))
  if err != nil {
    log.Printf("%s [v2] Failed to write CONNECT response: %v", logPrefixError, err)
    clientConn.Close()
    return
  }

  ctx, cancel := context.WithCancel(r.Context())
  defer cancel()

  if p.config.StreamTimeout > 0 {
    ctx, cancel = context.WithTimeout(ctx, p.config.StreamTimeout)
    defer cancel()
  }

  sessionID := generateSessionID()
  log.Printf("%s [v2] Generated Session ID: %s", logPrefixInfo, sessionID)

  var wg sync.WaitGroup
  wg.Add(2)

  var closeOnce sync.Once
  var connMutex sync.Mutex
  tunnelClose := func() {
    connMutex.Lock()
    defer connMutex.Unlock()
    clientConn.Close()
    cancel()
  }

  // POST request (client -> target)
  go func() {
    defer wg.Done()

    postReq, err := http.NewRequestWithContext(ctx, "POST", p.config.UpstreamURLPOST, clientConn)
    if err != nil {
      log.Printf("%s [v2] Failed to create POST request: %v", logPrefixError, err)
      closeOnce.Do(tunnelClose)
      return
    }
    p.setTunnelHeaders(postReq, targetHost, targetPort, sessionID)

    postResp, err := p.httpClientPOST.Do(postReq)
    if err != nil && !isExpectedError(err) {
      log.Printf("%s [v2] POST request failed: %v", logPrefixError, err)
      closeOnce.Do(tunnelClose)
      return
    }
    if postResp == nil {
      closeOnce.Do(tunnelClose)
      return
    }
    defer postResp.Body.Close()

    if postResp.StatusCode != http.StatusCreated {
      log.Printf("%s [v2] Upstream POST failed with status: %s", logPrefixError, postResp.Status)
      closeOnce.Do(tunnelClose)
      return
    }
    log.Printf("%s [v2] Upstream POST tunnel established", logPrefixTunnel)
    closeOnce.Do(tunnelClose)
  }()

  // GET request (target -> client)
  go func() {
    defer wg.Done()

    getReq, err := http.NewRequestWithContext(ctx, "GET", p.config.UpstreamURLGET, nil)
    if err != nil {
      log.Printf("%s [v2] Failed to create GET request: %v", logPrefixError, err)
      closeOnce.Do(tunnelClose)
      return
    }
    p.setTunnelHeaders(getReq, targetHost, targetPort, sessionID)

    getResp, err := p.httpClientGET.Do(getReq)
    if err != nil && !isExpectedError(err) {
      log.Printf("%s [v2] GET request failed: %v", logPrefixError, err)
      closeOnce.Do(tunnelClose)
      return
    }
    if getResp == nil {
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

    buf := make([]byte, 128*1024)
    connMutex.Lock()
    _, err = io.CopyBuffer(clientConn, getResp.Body, buf)
    connMutex.Unlock()
    if err != nil && !isExpectedError(err) {
      log.Printf("%s [v2] Stream error: %v", logPrefixError, err)
    }
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
  req.Header.Set("Cache-Control", "no-cache")
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
  var urlBoth string
  var httpVersionBoth string
  var showVersion bool
  flag.StringVar(&cfg.ListenAddr, "listen", "127.0.0.1:8080", "Local address for the proxy to listen on")
  flag.StringVar(&urlBoth, "url", "", "URL for both POST/upload and GET/download")
  flag.StringVar(&cfg.UpstreamURLPOST, "url-post", "", "URL for POST/upload (e.g., http://server.com/tunnel)")
  flag.StringVar(&cfg.UpstreamURLGET, "url-get", "", "URL for GET/download (e.g., https://server.com/tunnel)")
  flag.StringVar(&cfg.UpstreamAddr, "addr", "", "Override IP address for the upstream server (e.g., 1.2.3.4)")
  flag.StringVar(&cfg.AuthToken, "token", "", "Authentication token for the upstream server")
  flag.IntVar(&cfg.Version, "version", 2, "Protocol version to use (1 or 2)")
  flag.StringVar(&httpVersionBoth, "http", "auto", "HTTP version for both POST and GET")
  flag.StringVar(&cfg.HTTPVersionPOST, "http-post", "", "HTTP version for POST/upload (auto, h2, h2c, h3)")
  flag.StringVar(&cfg.HTTPVersionGET, "http-get", "", "HTTP version for GET/download (auto, h2, h2c, h3)")
  flag.BoolVar(&cfg.InsecureSkipVerify, "insecure", true, "Skip TLS certificate verification")
  flag.DurationVar(&cfg.ConnTimeout, "conn-timeout", 10*time.Second, "Connection timeout")
  flag.DurationVar(&cfg.StreamTimeout, "stream-timeout", 0, "Stream timeout (0 = no timeout)")
  flag.BoolVar(&showVersion, "v", false, "Show version")
  flag.Parse()

  if showVersion {
    fmt.Printf("TwoPass Client %s\n", Version)
    return
  }

  if urlBoth != "" {
    if cfg.UpstreamURLPOST == "" {
      cfg.UpstreamURLPOST = urlBoth
    }
    if cfg.UpstreamURLGET == "" {
      cfg.UpstreamURLGET = urlBoth
    }
  }

  if httpVersionBoth != "" && httpVersionBoth != "auto" {
    if cfg.HTTPVersionPOST == "" {
      cfg.HTTPVersionPOST = httpVersionBoth
    }
    if cfg.HTTPVersionGET == "" {
      cfg.HTTPVersionGET = httpVersionBoth
    }
  }

  if cfg.UpstreamURLPOST == "" || cfg.UpstreamURLGET == "" || cfg.AuthToken == "" {
    flag.Usage()
    log.Fatalf("%s Upstream URLs and Authentication token are required.", logPrefixError)
  }

  if cfg.Version != 1 && cfg.Version != 2 {
    log.Fatalf("%s Invalid protocol version specified. Must be 1 or 2.", logPrefixError)
  }

  log.Printf("%s HTTP proxy server starting... (version %s)", logPrefixInfo, Version)
  proxy, err := NewProxy(cfg)
  if err != nil {
    log.Fatalf("%s Failed to create proxy: %v", logPrefixError, err)
  }
  if err := proxy.Start(); err != nil {
    log.Fatalf("%s Failed to start proxy server: %v", logPrefixError, err)
  }
}
