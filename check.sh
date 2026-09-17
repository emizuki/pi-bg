#!/bin/sh
# Run the same complete verification used before merging: strict types, then behavioral tests.
set -eu
cd "$(dirname "$0")"
npm run check
