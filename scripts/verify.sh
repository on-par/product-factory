#!/usr/bin/env bash
# Full verification gate. Mirrors .github/workflows/ci.yml.
# Run this before every commit and make sure it is green.
set -euo pipefail

echo "==> install (npm ci)"
npm ci

echo "==> format check"
npm run format:check

echo "==> build"
npm run build

echo "==> typecheck"
npm run typecheck

echo "==> lint"
npm run lint

echo "==> test (with coverage thresholds)"
npm run test

echo "==> ✅ verify passed"
