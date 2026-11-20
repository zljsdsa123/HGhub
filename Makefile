.PHONY: check test-rust test-web test-smoke docs budget release-check

# The verification of record is GitHub Actions. These targets are the same
# commands CI runs, so a local run (when requested) and CI cannot drift.
check: test-rust test-web docs budget release-check

test-rust:
	cargo check --manifest-path src-tauri/Cargo.toml --all-targets
	cargo test --manifest-path src-tauri/Cargo.toml --lib

test-web:
	pnpm build

test-smoke:
	pnpm test:smoke

budget:
	node scripts/check-size-budgets.mjs

docs:
	node scripts/check-doc-links.mjs

release-check:
	node scripts/check-version-sync.mjs
