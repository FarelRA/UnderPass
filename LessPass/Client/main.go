package main

import (
	"bytes"
	"crypto/tls"
	"encoding/binary"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/url"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

const (
	VLESSVersion   = 0
	CommandTCP     = 1
	CommandUDP     = 2
	AddressTypeIPv4 = 1
	AddressTypeFQDN = 2
	AddressTypeIPv6 = 3
)

var (
	serverURL = flag.String("server", "wss://your-worker.workers.dev", "VLESS server WebSocket URL")
	userID    = flag.String("uuid", "86c50e3a-5b87-49dd-bd20-03c7f2735e40", "VLESS user UUID")
	localAddr = flag.String("local", "127.0.0.1:1080", "Local SOCKS5 proxy address")
)

func main() {
	flag.Parse()

	log.Printf("Starting VLESS client...")
	log.Printf("Server: %s", *serverURL)
	log.Printf("Local SOCKS5: %s", *localAddr)

	listener, err := net.Listen("tcp", *localAddr)
	if err != nil {
		log.Fatalf("Failed to listen: %v", err)
	}
	defer listener.Close()

	log.Printf("SOCKS5 proxy listening on %s", *localAddr)

	for {
		conn, err := listener.Accept()
		if err != nil {
			log.Printf("Accept error: %v", err)
			continue
		}
		go handleSOCKS5(conn)
	}
}

func handleSOCKS5(conn net.Conn) {
	defer conn.Close()

	// SOCKS5 handshake
	buf := make([]byte, 256)
	n, err := conn.Read(buf)
	if err != nil || n < 2 || buf[0] != 5 {
		return
	}

	// No authentication
	conn.Write([]byte{5, 0})

	// Read request
	n, err = conn.Read(buf)
	if err != nil || n < 7 || buf[0] != 5 || buf[1] != 1 {
		return
	}

	var host string
	var port uint16
	atyp := buf[3]

	switch atyp {
	case 1: // IPv4
		host = net.IP(buf[4:8]).String()
		port = binary.BigEndian.Uint16(buf[8:10])
	case 3: // Domain
		domainLen := int(buf[4])
		host = string(buf[5 : 5+domainLen])
		port = binary.BigEndian.Uint16(buf[5+domainLen : 7+domainLen])
	case 4: // IPv6
		host = net.IP(buf[4:20]).String()
		port = binary.BigEndian.Uint16(buf[20:22])
	default:
		conn.Write([]byte{5, 8, 0, 1, 0, 0, 0, 0, 0, 0})
		return
	}

	// Connect to VLESS server
	wsConn, err := connectVLESS(host, port)
	if err != nil {
		log.Printf("VLESS connection failed: %v", err)
		conn.Write([]byte{5, 1, 0, 1, 0, 0, 0, 0, 0, 0})
		return
	}
	defer wsConn.Close()

	// SOCKS5 success response
	conn.Write([]byte{5, 0, 0, 1, 0, 0, 0, 0, 0, 0})

	// Relay data
	relay(conn, wsConn)
}

func connectVLESS(host string, port uint16) (*websocket.Conn, error) {
	u, err := url.Parse(*serverURL)
	if err != nil {
		return nil, err
	}

	dialer := websocket.Dialer{
		TLSClientConfig: &tls.Config{InsecureSkipVerify: false},
	}

	wsConn, _, err := dialer.Dial(u.String(), nil)
	if err != nil {
		return nil, err
	}

	// Build VLESS header
	header := buildVLESSHeader(host, port)
	if err := wsConn.WriteMessage(websocket.BinaryMessage, header); err != nil {
		wsConn.Close()
		return nil, err
	}

	// Read VLESS response (2 bytes)
	_, resp, err := wsConn.ReadMessage()
	if err != nil || len(resp) < 2 {
		wsConn.Close()
		return nil, fmt.Errorf("invalid VLESS response")
	}

	return wsConn, nil
}

func buildVLESSHeader(host string, port uint16) []byte {
	buf := new(bytes.Buffer)

	// Version (1 byte)
	buf.WriteByte(VLESSVersion)

	// User ID (16 bytes UUID)
	uid, _ := uuid.Parse(*userID)
	buf.Write(uid[:])

	// Addon length (1 byte) - no addons
	buf.WriteByte(0)

	// Command (1 byte) - TCP
	buf.WriteByte(CommandTCP)

	// Port (2 bytes, big-endian)
	binary.Write(buf, binary.BigEndian, port)

	// Address
	ip := net.ParseIP(host)
	if ip != nil {
		if ip4 := ip.To4(); ip4 != nil {
			// IPv4
			buf.WriteByte(AddressTypeIPv4)
			buf.Write(ip4)
		} else {
			// IPv6
			buf.WriteByte(AddressTypeIPv6)
			buf.Write(ip)
		}
	} else {
		// Domain
		buf.WriteByte(AddressTypeFQDN)
		buf.WriteByte(byte(len(host)))
		buf.WriteString(host)
	}

	return buf.Bytes()
}

func relay(local net.Conn, ws *websocket.Conn) {
	done := make(chan struct{}, 2)

	// Local -> WebSocket
	go func() {
		defer func() { done <- struct{}{} }()
		buf := make([]byte, 32*1024)
		for {
			n, err := local.Read(buf)
			if err != nil {
				return
			}
			if err := ws.WriteMessage(websocket.BinaryMessage, buf[:n]); err != nil {
				return
			}
		}
	}()

	// WebSocket -> Local
	go func() {
		defer func() { done <- struct{}{} }()
		for {
			_, data, err := ws.ReadMessage()
			if err != nil {
				return
			}
			if _, err := local.Write(data); err != nil {
				return
			}
		}
	}()

	<-done
}
