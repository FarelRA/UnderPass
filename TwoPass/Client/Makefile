.PHONY: all build clean checksums

VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
LDFLAGS := -s -w -X main.Version=$(VERSION)
GCFLAGS := -l=4
BUILD_FLAGS := CGO_ENABLED=0 GOOS=linux
DIST_DIR := dist

TARGETS := \
	$(DIST_DIR)/twopass-armv7 \
	$(DIST_DIR)/twopass-armv8 \
	$(DIST_DIR)/twopass-x86 \
	$(DIST_DIR)/twopass-x86_64

all: build checksums

build: $(TARGETS)

$(DIST_DIR)/twopass-armv7:
	@echo "Building ARMv7..."
	@mkdir -p $(DIST_DIR)
	$(BUILD_FLAGS) GOARCH=arm GOARM=7 go build -ldflags="$(LDFLAGS)" -trimpath -gcflags="$(GCFLAGS)" -o $@

$(DIST_DIR)/twopass-armv8:
	@echo "Building ARMv8..."
	@mkdir -p $(DIST_DIR)
	$(BUILD_FLAGS) GOARCH=arm64 go build -ldflags="$(LDFLAGS)" -trimpath -gcflags="$(GCFLAGS)" -o $@

$(DIST_DIR)/twopass-x86:
	@echo "Building x86..."
	@mkdir -p $(DIST_DIR)
	$(BUILD_FLAGS) GOARCH=386 go build -ldflags="$(LDFLAGS)" -trimpath -gcflags="$(GCFLAGS)" -o $@

$(DIST_DIR)/twopass-x86_64:
	@echo "Building x86_64..."
	@mkdir -p $(DIST_DIR)
	$(BUILD_FLAGS) GOARCH=amd64 go build -ldflags="$(LDFLAGS)" -trimpath -gcflags="$(GCFLAGS)" -o $@

checksums: $(TARGETS)
	@echo "Generating SHA256 checksums..."
	@cd $(DIST_DIR) && sha256sum twopass-* > SHA256SUMS
	@echo "Checksums saved to $(DIST_DIR)/SHA256SUMS"

clean:
	@echo "Cleaning build artifacts..."
	@rm -rf $(DIST_DIR)

verify:
	@echo "Verifying checksums..."
	@cd $(DIST_DIR) && sha256sum -c SHA256SUMS
