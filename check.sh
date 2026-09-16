#!/bin/sh
# Type-check for unresolved identifiers.
#
# bun build only transpiles: it will happily emit a call to a function that does not exist, which
# is exactly how a deleted helper once reached main here. Peer dependencies are not installed, so
# module-resolution errors are expected noise; only unresolved names fail this check.
cd "$(dirname "$0")" || exit 1

if ! command -v tsc >/dev/null 2>&1; then
  echo "tsc not found: the check cannot run, so it must not pass." >&2
  exit 1
fi
out=$(tsc --noEmit --skipLibCheck --target es2022 --module esnext --moduleResolution bundler \
  extensions/bg/index.ts 2>&1)
bad=$(printf '%s\n' "$out" | grep -E "TS2304|TS2551|TS2552")
if [ -n "$bad" ]; then
  printf 'Unresolved names:\n%s\n' "$bad"
  exit 1
fi
echo "NAMES OK"
