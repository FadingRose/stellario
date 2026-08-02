# stellario release — package the unified tool + skill for distribution.
#
#   make release VERSION=0.2.0            # linux-amd64 (local platform)
#   make release VERSION=0.2.0 TARGET=aarch64-apple-darwin   # on mac/CI
#
# Output: dist/stella-<version>-<platform>.tar.gz + .sha256
# Platform naming: <os>-<arch> (linux-amd64, darwin-arm64, ...).

VERSION ?= 0.2.0
TARGET  ?= $(shell rustc -vV | sed -n 's/host: //p')

# Map rust target triple → release platform name.
PLATFORM := $(shell echo "$(TARGET)" | sed \
	-e 's/x86_64-unknown-linux-gnu/linux-amd64/' \
	-e 's/aarch64-apple-darwin/darwin-arm64/' \
	-e 's/x86_64-apple-darwin/darwin-amd64/' \
	-e 's/aarch64-unknown-linux-gnu/linux-arm64/')

PKG      := stella-$(VERSION)-$(PLATFORM)
DIST     := dist/$(PKG)

.PHONY: release check test install clean

release: check
	@echo "==> building $(TARGET) → $(PLATFORM)"
	cd engine-rs && cargo build --release --target $(TARGET)
	rm -rf $(DIST) && mkdir -p $(DIST)
	cp engine-rs/target/$(TARGET)/release/stella        $(DIST)/stella
	ln -s stella $(DIST)/stellario
	cp engine-rs/target/$(TARGET)/release/stellario-mcp $(DIST)/
	cp engine-rs/target/$(TARGET)/release/stellario-migrate $(DIST)/
	mkdir -p $(DIST)/skills && cp -r skills/stellario $(DIST)/skills/stellario
	cp README.md $(DIST)/README.md
	@echo "  stella — one tool, five verb classes (query/sync/lint/doctor/migrate)"
	@echo "  stellario — alias (symlink)"
	@echo "  skills/stellario/ — the agent skill (SKILL.md, open format)"
	cd dist && tar czf $(PKG).tar.gz $(PKG)
	cd dist && shasum -a 256 $(PKG).tar.gz > $(PKG).tar.gz.sha256
	@echo "==> dist/$(PKG).tar.gz + .sha256"

check:
	cd engine-rs && cargo test -p stellario-engine

install: release
	tar xzf dist/$(PKG).tar.gz -C ~/.local/bin --strip-components=1 $(PKG)/stella $(PKG)/stellario
	ln -sfn $(CURDIR)/skills/stellario ~/.agents/skills/stellario
	@echo "installed stella to ~/.local/bin; skill linked to ~/.agents/skills/stellario"

clean:
	rm -rf dist
