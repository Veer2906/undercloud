#!/usr/bin/env bash
# Shared helpers for scripts/deploy.sh, scripts/verify.sh and scripts/anvil-deploy.sh.
# Source it; do not run it. Every helper prints what it is doing so a first-time user can follow.

# Repo root = the parent of the scripts/ directory (works no matter where the script is invoked from).
UC_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UC_CONTRACTS="$UC_ROOT/contracts"
UC_CHAIN_ID=421614
UC_EXPLORER="https://sepolia.arbiscan.io"

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf '\n\033[1;33mWARNING: %s\033[0m\n' "$*" >&2; }
die()  { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "'$1' is not installed or not on PATH. $2"
}

# Load the root .env (if present) so its variables are visible to forge/cast and to this shell.
# `set -a` exports every variable the file defines; `set +a` switches that back off.
load_env() {
  if [ -f "$UC_ROOT/.env" ]; then
    set -a; # shellcheck disable=SC1091
    source "$UC_ROOT/.env"; set +a
    note "loaded $UC_ROOT/.env"
  else
    warn "no .env at $UC_ROOT/.env (run 'pnpm keygen' to create one from .env.example)"
  fi
}

# require_var NAME "how to fix"  - fails loudly on an unset, empty, or placeholder ("0x", "0x...") value.
require_var() {
  local name="$1" hint="${2:-}" val="${!1:-}"
  case "$val" in
    ""|0x|0x...|"0x..."|"...")
      die "$name is missing or still a placeholder in .env. $hint" ;;
  esac
}

# require_pubkey65 NAME - a 65-byte uncompressed secp256k1 key is "0x04" + 128 hex chars = 132 chars.
require_pubkey65() {
  local name="$1" val="${!1:-}"
  require_var "$name" "Run 'pnpm keygen' (it derives ARBITER_PUBKEY from ARBITER_PRIVATE_KEY)."
  if ! [[ "$val" =~ ^0x04[0-9a-fA-F]{128}$ ]]; then
    die "$name must be a 65-byte uncompressed public key (0x04 followed by 128 hex chars); got ${#val} chars."
  fi
}

require_address() {
  local name="$1" val="${!1:-}"
  require_var "$name" "Run 'pnpm keygen'."
  [[ "$val" =~ ^0x[0-9a-fA-F]{40}$ ]] || die "$name is not a 20-byte hex address: $val"
}

require_privkey() {
  local name="$1" val="${!1:-}"
  require_var "$name" "Run 'pnpm keygen' to generate testnet burner keys (never paste a real wallet key)."
  [[ "$val" =~ ^0x[0-9a-fA-F]{64}$ ]] || die "$name must be 0x + 64 hex chars."
}

# broadcast_field <run-latest.json> <address|block|txhash>
# Reads the Undercloud CREATE transaction out of a forge broadcast file. Uses python3 (present on macOS)
# and falls back to sed if python3 is unavailable.
broadcast_field() {
  local file="$1" field="$2"
  [ -f "$file" ] || die "broadcast file not found: $file (did the deploy run?)"
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$file" "$field" <<'PY'
import json, sys
path, field = sys.argv[1], sys.argv[2]
d = json.load(open(path))
creates = [t for t in d.get("transactions", []) if t.get("transactionType") == "CREATE" and t.get("contractName") == "Undercloud"]
if not creates:
    sys.exit("no Undercloud CREATE transaction in " + path)
tx = creates[-1]
if field == "address":
    print(tx["contractAddress"])
elif field == "txhash":
    print(tx["hash"])
elif field == "block":
    rc = [r for r in d.get("receipts", []) if r.get("transactionHash") == tx["hash"]]
    if not rc:
        sys.exit("no receipt for " + tx["hash"] + " in " + path)
    print(int(rc[-1]["blockNumber"], 16))
else:
    sys.exit("unknown field " + field)
PY
  else
    case "$field" in
      address) sed -n 's/.*"contractAddress": *"\(0x[0-9a-fA-F]\{40\}\)".*/\1/p' "$file" | head -1 ;;
      txhash)  sed -n 's/.*"hash": *"\(0x[0-9a-fA-F]\{64\}\)".*/\1/p' "$file" | head -1 ;;
      block)   printf '%d\n' "$(sed -n 's/.*"blockNumber": *"\(0x[0-9a-fA-F]*\)".*/\1/p' "$file" | head -1)" ;;
      *) die "unknown field $field" ;;
    esac
  fi
}

# rubric_hash - keccak256 of the EXACT bytes of contracts/rubric.md (trailing newline included).
# This must equal what Deploy.s.sol computes with keccak256(bytes(vm.readFile("rubric.md"))).
# Pipe the file so nothing strips the final newline ("$(cat file)" would drop it and change the hash).
rubric_hash() {
  cast keccak < "$UC_CONTRACTS/rubric.md"
}
