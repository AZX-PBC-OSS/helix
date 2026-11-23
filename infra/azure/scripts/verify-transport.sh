#!/usr/bin/env bash
set -euo pipefail
exec python3 "$(dirname "$0")/verify-transport.py" "${1:?Usage: verify-transport.sh RESOURCE_GROUP}"
