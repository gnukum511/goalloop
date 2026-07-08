#!/usr/bin/env bash
# Install goalloop globally: CLI on PATH + GOALLOOP_HOME in shell profile.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="${HOME}/.local/bin"
MARKER="# goalloop harness"
ZSHRC="${HOME}/.zshrc"

echo "→ Installing goalloop from ${ROOT}"

mkdir -p "${BIN}"

cd "${ROOT}"
if command -v pnpm >/dev/null 2>&1; then
  pnpm install
else
  npm install
fi

chmod +x "${ROOT}/bin/goalloop.mjs"
ln -sf "${ROOT}/bin/goalloop.mjs" "${BIN}/goalloop"

if ! grep -q "${MARKER}" "${ZSHRC}" 2>/dev/null; then
  cat >>"${ZSHRC}" <<EOF

${MARKER}
export GOALLOOP_HOME="${ROOT}"
EOF
  echo "→ Added GOALLOOP_HOME to ${ZSHRC}"
else
  echo "→ GOALLOOP_HOME already in ${ZSHRC}"
fi

if [[ ":${PATH}:" != *":${BIN}:"* ]]; then
  echo "→ Note: ensure ${BIN} is on your PATH (Cursor/Claude shells usually include it)"
fi

echo ""
echo "✅ goalloop installed"
echo "   CLI:  ${BIN}/goalloop"
echo "   Home: ${ROOT}"
echo ""
echo "Usage (from any project directory):"
echo '  goalloop "Build X with tests — success when pnpm test exits 0"'
echo "  goalloop --resume"
