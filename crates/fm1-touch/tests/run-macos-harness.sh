#!/bin/sh
set -eu
if [ "$(uname -s)" != Darwin ]; then
    echo 'SKIP: AppKit harness requires macOS'
    exit 0
fi
test_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
test_binary=$(mktemp "${TMPDIR:-/tmp}/fm1-touch-harness.XXXXXX")
trap 'rm -f "$test_binary"' EXIT HUP INT TERM
xcrun clang -fobjc-arc -Wall -Wextra -Werror -mmacosx-version-min=10.13 \
    "$test_dir/macos_harness.m" -framework AppKit -o "$test_binary"
"$test_binary"
