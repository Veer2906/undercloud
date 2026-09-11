#!/usr/bin/env bash
# Verifies the already-deployed Undercloud source on Arbiscan (or Sourcify) after the fact.
# Use it when `pnpm deploy:contract` deployed fine but the --verify step failed or was skipped.
#
# What it does:
#   1. finds the deployed address in contracts/broadcast/Deploy.s.sol/421614/run-latest.json
#      (override with `UNDERCLOUD_ADDRESS=0x… pnpm verify:contract` or `bash scripts/verify.sh 0x…`)
#   2. rebuilds the exact constructor arguments the contract was deployed with, reading the
#      committed values back FROM THE CHAIN (rubricHash, timing windows, arbiter) so the encoded
#      arguments are guaranteed to match, and cross-checks them against .env and rubric.md
#   3. runs `forge verify-contract` against Etherscan API V2 (one etherscan.io key covers Arbiscan),
#      or against Sourcify when ETHERSCAN_API_KEY is empty / VERIFIER=sourcify is set
#
# Usage: pnpm verify:contract   |   bash scripts/verify.sh [address]   |   VERIFIER=sourcify pnpm verify:contract
#        VERIFY_DRY_RUN=1 pnpm verify:contract   prints the exact forge command instead of running it
set -euo pipefail
# shellcheck disable=SC1091
source "$(dirname "$0")/lib.sh"
cd "$UC_ROOT"

say "Undercloud verify - Arbitrum Sepolia (chain $UC_CHAIN_ID)"
need_cmd forge "Install Foundry: curl -L https://getfoundry.sh/install | bash, then open a new terminal and run foundryup."
need_cmd cast  "Install Foundry (see above)."
load_env
require_address  ARBITER_ADDRESS
require_pubkey65 ARBITER_PUBKEY
export ARBITRUM_SEPOLIA_RPC_URL="${ARBITRUM_SEPOLIA_RPC_URL:-https://sepolia-rollup.arbitrum.io/rpc}"
ETHERSCAN_API_KEY="${ETHERSCAN_API_KEY:-}"
VERIFIER="${VERIFIER:-}"

# ---- 1. which contract ----------------------------------------------------------------------
cd "$UC_CONTRACTS"
RUN_LATEST="$UC_CONTRACTS/broadcast/Deploy.s.sol/$UC_CHAIN_ID/run-latest.json"
ADDR="${1:-${UNDERCLOUD_ADDRESS:-}}"
if [ -z "$ADDR" ]; then
  [ -f "$RUN_LATEST" ] || die "No deploy record at $RUN_LATEST. Run 'pnpm deploy:contract' first, or pass the address: bash scripts/verify.sh 0x…"
  ADDR="$(cast to-check-sum-address "$(broadcast_field "$RUN_LATEST" address)")"
  note "address from broadcast record: $ADDR"
else
  note "address from argument/env: $ADDR"
fi
[[ "$ADDR" =~ ^0x[0-9a-fA-F]{40}$ ]] || die "not an address: $ADDR"

# ---- 2. constructor args, read back from the chain ---------------------------------------
say "Reading the committed constructor values from the chain"
rpc() { cast call "$ADDR" "$@" --rpc-url "$ARBITRUM_SEPOLIA_RPC_URL"; }
CODE="$(cast code "$ADDR" --rpc-url "$ARBITRUM_SEPOLIA_RPC_URL" 2>/dev/null || echo 0x)"
[ "$CODE" != "0x" ] || die "No contract code at $ADDR on Arbitrum Sepolia. Wrong address, wrong RPC, or the deploy tx has not landed yet."

ON_ARBITER="$(rpc 'arbiter()(address)')"
ON_MODEL="$(rpc 'arbiterModelId()(string)' | sed 's/^"\(.*\)"$/\1/')"
ON_RUBRIC="$(rpc 'rubricHash()(bytes32)')"
ON_PUBKEY="$(rpc 'arbiterPubKey()(bytes)')"
ON_QW="$(rpc 'qualityWindow()(uint64)')"
ON_DT="$(rpc 'deliverTimeout()(uint64)')"
ON_AT="$(rpc 'arbiterTimeout()(uint64)')"
note "arbiter:        $ON_ARBITER"
note "model id:       $ON_MODEL"
note "rubricHash:     $ON_RUBRIC"
note "windows:        quality=${ON_QW}s deliver=${ON_DT}s arbiter=${ON_AT}s"

# Cross-checks: the values in .env / rubric.md should be what was deployed. A mismatch is only a
# warning for verification (the on-chain values are what the bytecode was created with), but it
# means the agents' .env no longer describes this deployment - so say so loudly.
LOCAL_RUBRIC="$(rubric_hash)"   # == cast keccak < contracts/rubric.md  (exact bytes, trailing newline included)
if [ "$LOCAL_RUBRIC" != "$ON_RUBRIC" ]; then
  warn "contracts/rubric.md hashes to $LOCAL_RUBRIC but the contract committed to $ON_RUBRIC. The arbiter agent will refuse to start until rubric.md matches the deployed hash. (Hash the file with: cast keccak < contracts/rubric.md - do NOT use \"\$(cat file)\", it strips the trailing newline.)"
fi
if [ "$(echo "$ON_ARBITER" | tr 'A-F' 'a-f')" != "$(echo "$ARBITER_ADDRESS" | tr 'A-F' 'a-f')" ]; then
  warn "ARBITER_ADDRESS in .env ($ARBITER_ADDRESS) differs from the deployed arbiter ($ON_ARBITER). Using the on-chain value for verification."
fi
if [ "$(echo "$ON_PUBKEY" | tr 'A-F' 'a-f')" != "$(echo "$ARBITER_PUBKEY" | tr 'A-F' 'a-f')" ]; then
  warn "ARBITER_PUBKEY in .env differs from the deployed arbiterPubKey. Using the on-chain value for verification."
fi

# `cast abi-encode "constructor(...)" …` encodes the arguments without a selector, which is exactly
# the tail that verifiers need to reproduce the creation bytecode.
CONSTRUCTOR_ARGS="$(cast abi-encode 'constructor(address,bytes,string,bytes32,uint64,uint64,uint64)' \
  "$ON_ARBITER" "$ON_PUBKEY" "$ON_MODEL" "$ON_RUBRIC" "$ON_QW" "$ON_DT" "$ON_AT")"
note "constructor args: ${CONSTRUCTOR_ARGS:0:42}… (${#CONSTRUCTOR_ARGS} hex chars)"

# ---- 3. verify -------------------------------------------------------------------------------
say "forge build (so the compiler settings in foundry.toml are the ones submitted)"
forge build -q

CMD=(forge verify-contract --chain "$UC_CHAIN_ID" --watch --constructor-args "$CONSTRUCTOR_ARGS" "$ADDR" src/Undercloud.sol:Undercloud)
if [ "$VERIFIER" = "sourcify" ] || [ -z "$ETHERSCAN_API_KEY" ]; then
  if [ -z "$ETHERSCAN_API_KEY" ] && [ "$VERIFIER" != "sourcify" ]; then
    warn "ETHERSCAN_API_KEY is empty - falling back to Sourcify (no key needed). Arbiscan will not show the green check unless it imports from Sourcify; add a free key from https://etherscan.io/myapikey and re-run for Arbiscan verification."
  fi
  say "Verifying on Sourcify"
  CMD+=(--verifier sourcify)
else
  say "Verifying on Arbiscan (Etherscan API V2, chain $UC_CHAIN_ID; one etherscan.io key covers Arbiscan)"
  CMD+=(--verifier etherscan --etherscan-api-key "$ETHERSCAN_API_KEY")
fi
if [ "${VERIFY_DRY_RUN:-}" = "1" ]; then
  note "VERIFY_DRY_RUN=1 - would run (from $UC_CONTRACTS):"
  printf '    %q ' "${CMD[@]}"; echo
  exit 0
fi
"${CMD[@]}"

say "Done"
note "contract: $UC_EXPLORER/address/$ADDR#code"
note "If Arbiscan says 'unable to locate contract', wait 30 s and run 'pnpm verify:contract' again."
note "If it says 'already verified', nothing more to do."
echo
echo "Next: pnpm sync   (if you have not run it yet), then pnpm fund && pnpm demo"
