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

// ============================================================================
// Constants and Global Variables
// ============================================================================

var Version = "dev"

const (
	protocolV1       = "v1"
	protocolV2       = "v2"
	logPrefixInfo    = "[*]"
	logPrefixSuccess = "[+]"
	logPrefixRequest = "[>]"
	logPrefixTunnel  = "[<]"
	logPrefixStream  = "[=]"
	logPrefixClose   = "[-]"
	logPrefixError   = "[!]"
	bufferSize       = 128 * 1024
	idleConnTimeout  = 120 * time.Second
)

// ============================================================================
// Types
// ============================================================================

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

type Proxy struct {
	config         Config
	httpClientPOST *http.Client
	httpClientGET  *http.Client
}

// ============================================================================
// HTTP Transport Factory Functions
// ============================================================================

func createH3Transport(cfg Config, overrideAddr, port string) *http3.Transport {
	transport := &http3.Transport{
		TLSClientConfig: &tls.Config{
			InsecureSkipVerify: cfg.InsecureSkipVerify,
		},
	}
	if overrideAddr != "" {
		transport.Dial = func(ctx context.Context, addr string, tlsCfg *tls.Config, quicCfg *quic.Config) (*quic.Conn, error) {
			udpAddr, err := net.ResolveUDPAddr("udp", net.JoinHostPort(overrideAddr, port))
			if err != nil {
				return nil, err
			}
			return quic.DialAddr(ctx, udpAddr.String(), tlsCfg, quicCfg)
		}
	}
	return transport
}

func createH2Transport(cfg Config, overrideAddr, port string, dialer *net.Dialer) *http.Transport {
	return &http.Transport{
		ForceAttemptHTTP2: true,
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			if overrideAddr != "" {
				addr = net.JoinHostPort(overrideAddr, port)
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
		IdleConnTimeout:     idleConnTimeout,
	}
}

func createH2CTransport(cfg Config, overrideAddr, hostname, port string, dialer *net.Dialer) *http2.Transport {
	return &http2.Transport{
		AllowHTTP: true,
		DialTLSContext: func(ctx context.Context, network, addr string, _ *tls.Config) (net.Conn, error) {
			if overrideAddr != "" {
				addr = net.JoinHostPort(overrideAddr, port)
			} else {
				addr = net.JoinHostPort(hostname, port)
			}
			return dialer.DialContext(ctx, network, addr)
		},
		IdleConnTimeout: idleConnTimeout,
	}
}

func createTransport(cfg Config, parsedURL *url.URL, httpVersion string, isGET bool) http.RoundTripper {
	port := extractPort(parsedURL)
	dialer := &net.Dialer{Timeout: cfg.ConnTimeout}

	if httpVersion == "" || httpVersion == "auto" {
		httpVersion = autoDetectHTTPVersion(parsedURL.Scheme, isGET)
	}

	direction := "POST"
	if isGET {
		direction = "GET"
	}

	switch httpVersion {
	case "h3":
		log.Printf("%s Configuring %s client for H3 (HTTP/3 over QUIC)", logPrefixInfo, direction)
		return createH3Transport(cfg, cfg.UpstreamAddr, port)
	case "h2":
		log.Printf("%s Configuring %s client for H2 (HTTP/2 over TLS)", logPrefixInfo, direction)
		return createH2Transport(cfg, cfg.UpstreamAddr, port, dialer)
	case "h2c":
		log.Printf("%s Configuring %s client for H2C (HTTP/2 over cleartext)", logPrefixInfo, direction)
		return createH2CTransport(cfg, cfg.UpstreamAddr, parsedURL.Hostname(), port, dialer)
	default:
		log.Fatalf("%s Unknown HTTP version: %s", logPrefixError, httpVersion)
		return nil
	}
}

// ============================================================================
// Proxy Constructor and Server
// ============================================================================

func NewProxy(cfg Config) (*Proxy, error) {
	parsedPOST, err := url.Parse(cfg.UpstreamURLPOST)
	if err != nil {
		return nil, fmt.Errorf("invalid POST URL: %w", err)
	}
	parsedGET, err := url.Parse(cfg.UpstreamURLGET)
	if err != nil {
		return nil, fmt.Errorf("invalid GET URL: %w", err)
	}

	transportPOST := createTransport(cfg, parsedPOST, cfg.HTTPVersionPOST, false)
	var transportGET http.RoundTripper
	if cfg.Version == 2 {
		transportGET = createTransport(cfg, parsedGET, cfg.HTTPVersionGET, true)
	}

	return &Proxy{
		config:         cfg,
		httpClientPOST: &http.Client{Transport: transportPOST, Timeout: 0},
		httpClientGET:  &http.Client{Transport: transportGET, Timeout: 0},
	}, nil
}

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

// ============================================================================
// Request Dispatcher
// ============================================================================

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

// ============================================================================
// V1 Protocol Handler
// ============================================================================

func (p *Proxy) handleConnectV1(w http.ResponseWriter, r *http.Request) {
	log.Printf("%s [%s] Proxy request for %s", logPrefixRequest, protocolV1, r.Host)

	targetHost, targetPort, err := parseAndFormatTarget(r.Host)
	if err != nil {
		log.Printf("%s [%s] Invalid target host format: %s", logPrefixError, protocolV1, r.Host)
		http.Error(w, "Invalid target host format", http.StatusBadRequest)
		return
	}

	clientConn, err := hijackAndRespond(w, p.config.StreamTimeout)
	if err != nil {
		log.Printf("%s [%s] Hijack failed: %v", logPrefixError, protocolV1, err)
		return
	}
	defer clientConn.Close()

	ctx := r.Context()
	if p.config.StreamTimeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, p.config.StreamTimeout)
		defer cancel()
	}

	postReq, err := http.NewRequestWithContext(ctx, "POST", p.config.UpstreamURLPOST, clientConn)
	if err != nil {
		log.Printf("%s [%s] Failed to create POST request: %v", logPrefixError, protocolV1, err)
		return
	}
	p.setTunnelHeaders(postReq, targetHost, targetPort, "")

	upstreamResp, err := p.httpClientPOST.Do(postReq)
	if err != nil {
		log.Printf("%s [%s] Failed to connect to upstream: %v", logPrefixError, protocolV1, err)
		return
	}
	defer upstreamResp.Body.Close()

	if upstreamResp.StatusCode != http.StatusOK {
		log.Printf("%s [%s] Upstream returned status: %s", logPrefixError, protocolV1, upstreamResp.Status)
		return
	}
	log.Printf("%s [%s] Upstream tunnel established", logPrefixTunnel, protocolV1)

	buf := make([]byte, bufferSize)
	_, err = io.CopyBuffer(clientConn, upstreamResp.Body, buf)
	if err != nil && !isExpectedError(err) {
		log.Printf("%s [%s] Stream error: %v", logPrefixError, protocolV1, err)
	}

	log.Printf("%s [%s] Connection closed for %s", logPrefixClose, protocolV1, r.Host)
}

// ============================================================================
// V2 Protocol Handlers
// ============================================================================

func (p *Proxy) handleConnectV2(w http.ResponseWriter, r *http.Request) {
	log.Printf("%s [%s] Proxy request for %s", logPrefixRequest, protocolV2, r.Host)

	targetHost, targetPort, err := parseAndFormatTarget(r.Host)
	if err != nil {
		log.Printf("%s [%s] Invalid CONNECT host: %s", logPrefixError, protocolV2, r.Host)
		http.Error(w, "Invalid target host format", http.StatusBadRequest)
		return
	}

	clientConn, err := hijackAndRespond(w, p.config.StreamTimeout)
	if err != nil {
		log.Printf("%s [%s] Hijack failed: %v", logPrefixError, protocolV2, err)
		return
	}

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	if p.config.StreamTimeout > 0 {
		ctx, cancel = context.WithTimeout(ctx, p.config.StreamTimeout)
		defer cancel()
	}

	sessionID := generateSessionID()
	log.Printf("%s [%s] Generated Session ID: %s", logPrefixInfo, protocolV2, sessionID)

	var wg sync.WaitGroup
	var closeOnce sync.Once
	var connMutex sync.Mutex

	tunnelClose := func() {
		connMutex.Lock()
		defer connMutex.Unlock()
		clientConn.Close()
		cancel()
	}

	// POST goroutine
	wg.Add(1)
	go func() {
		defer wg.Done()
		p.handleV2Upload(ctx, clientConn, targetHost, targetPort, sessionID, protocolV2, &closeOnce, tunnelClose)
	}()

	// GET goroutine
	wg.Add(1)
	go func() {
		defer wg.Done()
		p.handleV2Download(ctx, clientConn, targetHost, targetPort, sessionID, protocolV2, &connMutex, &closeOnce, tunnelClose)
	}()

	wg.Wait()
	log.Printf("%s [%s] Connection closed for %s", logPrefixClose, protocolV2, r.Host)
}

func (p *Proxy) handleV2Upload(ctx context.Context, clientConn net.Conn, targetHost, targetPort, sessionID, protocolV2 string, closeOnce *sync.Once, tunnelClose func()) {
	postReq, err := http.NewRequestWithContext(ctx, "POST", p.config.UpstreamURLPOST, clientConn)
	if err != nil {
		log.Printf("%s [%s] Failed to create POST request: %v", logPrefixError, protocolV2, err)
		closeOnce.Do(tunnelClose)
		return
	}
	p.setTunnelHeaders(postReq, targetHost, targetPort, sessionID)

	postResp, err := p.httpClientPOST.Do(postReq)
	if err != nil && !isExpectedError(err) {
		log.Printf("%s [%s] POST request failed: %v", logPrefixError, protocolV2, err)
		closeOnce.Do(tunnelClose)
		return
	}
	defer postResp.Body.Close()

	if postResp.StatusCode != http.StatusCreated {
		log.Printf("%s [%s] Upstream POST failed with status: %s", logPrefixError, protocolV2, postResp.Status)
		closeOnce.Do(tunnelClose)
		return
	}
	log.Printf("%s [%s] Upstream POST tunnel established", logPrefixTunnel, protocolV2)
	closeOnce.Do(tunnelClose)
}

func (p *Proxy) handleV2Download(ctx context.Context, clientConn net.Conn, targetHost, targetPort, sessionID, protocolV2 string, connMutex *sync.Mutex, closeOnce *sync.Once, tunnelClose func()) {
	getReq, err := http.NewRequestWithContext(ctx, "GET", p.config.UpstreamURLGET, nil)
	if err != nil {
		log.Printf("%s [%s] Failed to create GET request: %v", logPrefixError, protocolV2, err)
		closeOnce.Do(tunnelClose)
		return
	}
	p.setTunnelHeaders(getReq, targetHost, targetPort, sessionID)

	getResp, err := p.httpClientGET.Do(getReq)
	if err != nil && !isExpectedError(err) {
		log.Printf("%s [%s] GET request failed: %v", logPrefixError, protocolV2, err)
		closeOnce.Do(tunnelClose)
		return
	}
	defer getResp.Body.Close()

	if getResp.StatusCode != http.StatusOK {
		log.Printf("%s [%s] Upstream GET failed with status: %s", logPrefixError, protocolV2, getResp.Status)
		closeOnce.Do(tunnelClose)
		return
	}
	log.Printf("%s [%s] Upstream GET tunnel established", logPrefixTunnel, protocolV2)

	buf := make([]byte, bufferSize)
	connMutex.Lock()
	_, err = io.CopyBuffer(clientConn, getResp.Body, buf)
	connMutex.Unlock()
	if err != nil && !isExpectedError(err) {
		log.Printf("%s [%s] Stream error: %v", logPrefixError, protocolV2, err)
	}
	closeOnce.Do(tunnelClose)
}

// ============================================================================
// Helper Functions
// ============================================================================

func extractPort(u *url.URL) string {
	if port := u.Port(); port != "" {
		return port
	}
	if u.Scheme == "https" {
		return "443"
	}
	return "80"
}

func autoDetectHTTPVersion(scheme string, isGET bool) string {
	if scheme == "https" {
		if isGET {
			return "h3"
		}
		return "h2"
	}
	return "h2c"
}

func parseAndFormatTarget(hostPort string) (string, string, error) {
	host, port, err := net.SplitHostPort(hostPort)
	if err != nil {
		return "", "", err
	}
	if ip := net.ParseIP(host); ip != nil && ip.To4() == nil && host[0] != '[' {
		host = "[" + host + "]"
	}
	return host, port, nil
}

func hijackAndRespond(w http.ResponseWriter, streamTimeout time.Duration) (net.Conn, error) {
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		return nil, errors.New("hijacking not supported")
	}

	conn, _, err := hijacker.Hijack()
	if err != nil {
		return nil, fmt.Errorf("failed to hijack: %w", err)
	}

	if streamTimeout > 0 {
		conn.SetDeadline(time.Now().Add(streamTimeout))
	}

	_, err = conn.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n"))
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("failed to write response: %w", err)
	}

	return conn, nil
}

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

func isExpectedError(err error) bool {
	if err == nil {
		return true
	}
	return errors.Is(err, context.Canceled) ||
		errors.Is(err, net.ErrClosed) ||
		strings.Contains(err.Error(), "H3_REQUEST_CANCELLED")
}

func generateSessionID() string {
	const charset = "abcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, 6)
	for i := range b {
		b[i] = charset[rand.Intn(len(charset))]
	}
	return string(b)
}

// ============================================================================
// Main Entry Point
// ============================================================================

func main() {
	cfg := Config{}
	var urlBoth, httpVersionBoth string
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
