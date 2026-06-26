.PHONY: build install embed clean release release-all

VERSION ?= dev
COMMIT  ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)
DATE    ?= $(shell date -u +%Y-%m-%dT%H:%M:%SZ)

LDFLAGS := -X main.Version=$(VERSION) -X main.Commit=$(COMMIT) -X main.BuildDate=$(DATE)

PLATFORMS := darwin/arm64 darwin/amd64 linux/amd64 linux/arm64

embed:
	@echo "Preparing embedded TS source..."
	rm -rf embedfs/src embedfs/glue embedfs/templates
	cp -r ../src embedfs/src
	cp -r ../glue embedfs/glue
	cp -r ../templates embedfs/templates
	@echo "  done"

build: embed
	@echo "Building stellario $(VERSION)..."
	go build -ldflags "$(LDFLAGS)" -o stellario ./cmd/stellario
	./stellario version

install: build
	@echo "Installing..."
	go install -ldflags "$(LDFLAGS)" ./cmd/stellario
	@echo "  installed"

release-all: embed
	@echo "Building release $(VERSION) for all platforms..."
	@rm -rf dist
	@mkdir -p dist
	@for platform in $(PLATFORMS); do \
		os=$${platform%/*}; \
		arch=$${platform#*/}; \
		echo "  -> $$os/$$arch"; \
		GOOS=$$os GOARCH=$$arch go build -ldflags "$(LDFLAGS)" -o dist/stellario-$$os-$$arch ./cmd/stellario; \
	done
	@echo ""
	@echo "Built binaries:"
	@ls -lh dist/
	@echo ""
	@echo "All platforms ready in dist/"

release: release-all
	@if ! command -v gh > /dev/null; then \
		echo "Error: gh CLI not installed"; \
		exit 1; \
	fi
	@echo "Creating GitHub release $(VERSION)..."
	@printf 'Stellario %s\n\n## Install\n\n```bash\ncurl -fsSL https://github.com/FadingRose/stellario/releases/download/%s/stellario-$$(uname -s | tr A-Z a-z)-$$(uname -m) -o stellario\nchmod +x stellario\n./stellario setup\n```\n' "$(VERSION)" "$(VERSION)" > dist/release-notes.md
	gh release create $(VERSION) \
		dist/stellario-darwin-arm64 \
		dist/stellario-darwin-amd64 \
		dist/stellario-linux-amd64 \
		dist/stellario-linux-arm64 \
		--title "$(VERSION)" \
		--notes-file dist/release-notes.md
	@echo ""
	@echo "Release created: https://github.com/FadingRose/stellario/releases/tag/$(VERSION)"

clean:
	rm -rf embedfs/src embedfs/glue embedfs/templates stellario dist
