#!/usr/bin/env bash
# Deploys Undercloud to a LOCAL Anvil node for testing the agents/dashboard without testnet ETH.
#
# Assumes Anvil is already running and pretending to be Arbitrum Sepolia:
#     anvil --chain-id 421614            (default port 8545; set ANVIL_RPC_URL to use another)
# The deployer is Anvil's well-known dev account #0 (public test key, never holds real funds).
#
# Inputs (environment):
#   ARBITER_ADDRESS / ARBITER_PUBKEY   the judge's address and 65-byte pubkey. If both are unset the
#                                      script uses Anvil dev account #1 and prints the derived values.
#   QUALITY_WINDOW / DELIVER_TIMEOUT / ARBITER_TIMEOUT   seconds; default 20 / 40 / 60 for fast local runs
#   ANVIL_RPC_URL                      default http://127.0.0.1:8545
#
# Output: the deployed address + deploy block on stdout, contracts/broadcast/local-run-latest.json,
# and contracts/broadcast/local-deploy.env (UNDERCLOUD_ADDRESS / DEPLOY_BLOCK / RPC_URL) for the caller.
#
# Broadcast hygiene: forge writes every 421614 run to contracts/broadcast/Deploy.s.sol/421614/, the same
# directory the REAL testnet deploy uses (pnpm sync reads run-latest.json there). This script moves any
# existing real record aside first, copies the local record to broadcast/local-run-latest.json, deletes
# the local 421614 directory, and restores the real record - so a local run never masquerades as a deploy.
set -euo pipefail
# shellcheck disable=SC1091
source "$(dirname "$0")/lib.sh"

# Anvil's published dev keys (from `anvil` startup banner). Test-only; everyone knows them.
ANVIL_KEY0=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80   # 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
ANVIL_KEY1=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d   # 0x70997970C51812dc3A010C7d01b50e0d17dc79C8

RPC="${ANVIL_RPC_URL:-http://127.0.0.1:8545}"
export QUALITY_WINDOW="${QUALITY_WINDOW:-20}"
export DELIVER_TIMEOUT="${DELIVER_TIMEOUT:-40}"
export ARBITER_TIMEOUT="${ARBITER_TIMEOUT:-60}"

say "Undercloud local deploy (Anvil at $RPC)"
need_cmd forge "Install Foundry: curl -L https://getfoundry.sh/install | bash, then open a new terminal and run foundryup."
need_cmd cast  "Install Foundry (see above)."

# ---- 1. is Anvil up, and does it claim to be chain 421614? --------------------------------
CHAIN_ID="$(cast chain-id --rpc-url "$RPC" 2>/dev/null || true)"
[ -n "$CHAIN_ID" ] || die "Nothing is listening at $RPC. Start a node first, in another terminal:  anvil --chain-id $UC_CHAIN_ID"
[ "$CHAIN_ID" = "$UC_CHAIN_ID" ] || die "Anvil at $RPC reports chain id $CHAIN_ID; restart it with:  anvil --chain-id $UC_CHAIN_ID  (the agents and dashboard are hard-wired to $UC_CHAIN_ID)."
note "chain id $CHAIN_ID OK"

# ---- 2. arbiter identity -------------------------------------------------------------------
if [ -z "${ARBITER_ADDRESS:-}" ] && [ -z "${ARBITER_PUBKEY:-}" ]; then
  ARBITER_ADDRESS="$(cast wallet address --private-key "$ANVIL_KEY1")"
  # `cast wallet public-key` prints the 64-byte X||Y; the contract wants the 65-byte 0x04-prefixed form.
  ARBITER_PUBKEY="0x04$(cast wallet public-key --raw-private-key "$ANVIL_KEY1" | sed 's/^0x//')"
  warn "ARBITER_ADDRESS/ARBITER_PUBKEY not set - using Anvil dev account #1 as the arbiter (private key $ANVIL_KEY1)."
fi
export ARBITER_ADDRESS ARBITER_PUBKEY
require_address  ARBITER_ADDRESS
require_pubkey65 ARBITER_PUBKEY
note "arbiter:  $ARBITER_ADDRESS"
note "pubkey:   ${ARBITER_PUBKEY:0:14}… (65 bytes)"
note "windows:  quality=${QUALITY_WINDOW}s deliver=${DELIVER_TIMEOUT}s arbiter=${ARBITER_TIMEOUT}s"

# ---- 3. protect the real broadcast record, deploy, restore -------------------------------
cd "$UC_CONTRACTS"
BROADCAST_DIR="$UC_CONTRACTS/broadcast/Deploy.s.sol/$UC_CHAIN_ID"
CACHE_DIR="$UC_CONTRACTS/cache/Deploy.s.sol/$UC_CHAIN_ID"      # forge's "sensitive values" twin of the record
BACKUP_DIR=""; CACHE_BACKUP_DIR=""
if [ -d "$BROADCAST_DIR" ]; then
  BACKUP_DIR="$UC_CONTRACTS/broadcast/.real-$UC_CHAIN_ID-backup-$$"
  mv "$BROADCAST_DIR" "$BACKUP_DIR"
  note "moved existing testnet broadcast record aside (restored at the end)"
fi
if [ -d "$CACHE_DIR" ]; then
  CACHE_BACKUP_DIR="$UC_CONTRACTS/cache/.real-$UC_CHAIN_ID-backup-$$"
  mv "$CACHE_DIR" "$CACHE_BACKUP_DIR"
fi
# Restore the real record no matter how this script exits (success, failure, Ctrl-C).
cleanup() {
  rm -rf "$BROADCAST_DIR" "$CACHE_DIR"
  if [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ]; then
    mv "$BACKUP_DIR" "$BROADCAST_DIR"
    note "restored the testnet broadcast record"
  fi
  if [ -n "$CACHE_BACKUP_DIR" ] && [ -d "$CACHE_BACKUP_DIR" ]; then
    mv "$CACHE_BACKUP_DIR" "$CACHE_DIR"
  fi
  rmdir "$UC_CONTRACTS/broadcast/Deploy.s.sol" "$UC_CONTRACTS/cache/Deploy.s.sol" 2>/dev/null || true
}
trap cleanup EXIT

say "forge script Deploy (deployer = Anvil dev account #0)"
# --slow is unnecessary on Anvil; -q keeps the output to the console.log lines.
forge script script/Deploy.s.sol:Deploy --rpc-url "$RPC" --private-key "$ANVIL_KEY0" --broadcast -vv

RUN_LATEST="$BROADCAST_DIR/run-latest.json"
ADDR="$(cast to-check-sum-address "$(broadcast_field "$RUN_LATEST" address)")"
BLOCK="$(broadcast_field "$RUN_LATEST" block)"
cp "$RUN_LATEST" "$UC_CONTRACTS/broadcast/local-run-latest.json"
printf 'UNDERCLOUD_ADDRESS=%s\nDEPLOY_BLOCK=%s\nRPC_URL=%s\n' "$ADDR" "$BLOCK" "$RPC" > "$UC_CONTRACTS/broadcast/local-deploy.env"
# (the trap deletes $BROADCAST_DIR now and restores the real one, if any)

# ---- 4. sanity checks against the live node ----------------------------------------------
say "Sanity checks"
COUNT="$(cast call "$ADDR" 'listingCount()(uint256)' --rpc-url "$RPC")"
ON_RUBRIC="$(cast call "$ADDR" 'rubricHash()(bytes32)' --rpc-url "$RPC")"
LOCAL_RUBRIC="$(rubric_hash)"
note "listingCount() = $COUNT"
note "rubricHash()   = $ON_RUBRIC"
note "keccak(rubric) = $LOCAL_RUBRIC   (cast keccak < contracts/rubric.md)"
[ "$COUNT" = "0" ] || die "expected listingCount() == 0 on a fresh deploy, got $COUNT"
[ "$ON_RUBRIC" = "$LOCAL_RUBRIC" ] || die "rubricHash mismatch: contract has $ON_RUBRIC, contracts/rubric.md hashes to $LOCAL_RUBRIC"
note "OK"

say "Deployed locally"
note "Undercloud:  $ADDR"
note "deploy block: $BLOCK"
note "record:       contracts/broadcast/local-run-latest.json  and  contracts/broadcast/local-deploy.env"
echo
echo "Next: point the agents at it, e.g.  set -a; source contracts/broadcast/local-deploy.env; set +a"
echo "UNDERCLOUD_ADDRESS=$ADDR DEPLOY_BLOCK=$BLOCK"
