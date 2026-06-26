.PHONY: build install embed clean

VERSION ?= dev
COMMIT  ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)
DATE    ?= $(shell date -u +%Y-%m-%dT%H:%M:%SZ)

embed:
	@echo "Preparing embedded TS source..."
	rm -rf embedfs/src embedfs/glue embedfs/templates
	cp -r ../src embedfs/src
	cp -r ../glue embedfs/glue
	cp -r ../templates embedfs/templates
	@echo "  done"

build: embed
	@echo "Building stellario $(VERSION)..."
	go build -ldflags "-X main.Version=$(VERSION) -X main.Commit=$(COMMIT) -X main.BuildDate=$(DATE)" -o stellario ./cmd/stellario
	./stellario version

install: build
	@echo "Installing..."
	go install -ldflags "-X main.Version=$(VERSION) -X main.Commit=$(COMMIT) -X main.BuildDate=$(DATE)" ./cmd/stellario
	@echo "  installed"

clean:
	rm -rf embedfs/src embedfs/glue embedfs/templates stellario
