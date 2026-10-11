.DEFAULT_GOAL := build
PLUGIN_TAG ?= v$(shell node -p "require('./nora-plugin.json').version")
.PHONY: install build test package

install:
	pnpm install

build:
	node --check plugin.js
	node node_modules/@nora/plugin-kit/scripts/plugin-marketplace.mjs validate-manifest --manifest nora-plugin.json

test:
	node --test tests/*.test.js

package: build
	node node_modules/@nora/plugin-kit/scripts/plugin-marketplace.mjs package --config plugin-release.json --output dist --tag "$(PLUGIN_TAG)"
