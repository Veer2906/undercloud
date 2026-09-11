#!/usr/bin/env bash
# Deploys Undercloud to Arbitrum Sepolia (chain 421614) and verifies the source on Arbiscan.
#
# What it does, in order:
#   1. loads .env (DEPLOYER_PRIVATE_KEY, ARBITER_ADDRESS, ARBITER_PUBKEY, RPC URL, Etherscan key)
#   2. compiles and runs the full Foundry test suite - a red test aborts the deploy
#   3. runs contracts/script/Deploy.s.sol with the deployer key, broadcasting one CREATE transaction
#   4. (if ETHERSCAN_API_KEY is set) submits the source to Arbiscan for verification
#   5. prints the Arbiscan URL of the new contract and the next command to run
#
# Usage: pnpm deploy:contract      (or: bash scripts/deploy.sh)
set -euo pipefail
# shellcheck disable=SC1091
source "$(dirname "$0")/lib.sh"
cd "$UC_ROOT"

say "Undercloud deploy - Arbitrum Sepolia (chain $UC_CHAIN_ID)"
need_cmd forge "Install Foundry: curl -L https://getfoundry.sh/install | bash, then open a new terminal and run foundryup."
need_cmd cast  "Install Foundry (see above)."
load_env

# ---- 1. required configuration -------------------------------------------------------------
say "Checking .env"
require_privkey  DEPLOYER_PRIVATE_KEY
require_address  ARBITER_ADDRESS
require_pubkey65 ARBITER_PUBKEY
export ARBITRUM_SEPOLIA_RPC_URL="${ARBITRUM_SEPOLIA_RPC_URL:-https://sepolia-rollup.arbitrum.io/rpc}"
export ETHERSCAN_API_KEY="${ETHERSCAN_API_KEY:-}"
# Demo timing (seconds). Deploy.s.sol reads these; production values would be 172800 / 86400 / 604800.
export QUALITY_WINDOW="${QUALITY_WINDOW:-90}"
export DELIVER_TIMEOUT="${DELIVER_TIMEOUT:-180}"
export ARBITER_TIMEOUT="${ARBITER_TIMEOUT:-600}"
note "RPC:             $ARBITRUM_SEPOLIA_RPC_URL"
note "arbiter address: $ARBITER_ADDRESS"
note "arbiter pubkey:  ${ARBITER_PUBKEY:0:14}… (65 bytes)"
note "windows:         quality=${QUALITY_WINDOW}s deliver=${DELIVER_TIMEOUT}s arbiter=${ARBITER_TIMEOUT}s"
note "rubric hash:     $(rubric_hash)  (keccak256 of contracts/rubric.md, exact bytes)"

# ---- 2. sanity-check the chain and the deployer's balance ----------------------------------
say "Checking the RPC endpoint"
CHAIN_ID="$(cast chain-id --rpc-url "$ARBITRUM_SEPOLIA_RPC_URL" 2>/dev/null || true)"
[ -n "$CHAIN_ID" ] || die "Could not reach $ARBITRUM_SEPOLIA_RPC_URL. Check your internet connection or swap ARBITRUM_SEPOLIA_RPC_URL for another Arbitrum Sepolia RPC."
[ "$CHAIN_ID" = "$UC_CHAIN_ID" ] || die "RPC reports chain id $CHAIN_ID, expected $UC_CHAIN_ID (Arbitrum Sepolia). Fix ARBITRUM_SEPOLIA_RPC_URL in .env."
DEPLOYER="$(cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY")"
BALANCE_WEI="$(cast balance "$DEPLOYER" --rpc-url "$ARBITRUM_SEPOLIA_RPC_URL")"
BALANCE_ETH="$(cast from-wei "$BALANCE_WEI")"
note "deployer: $DEPLOYER"
note "balance:  $BALANCE_ETH ETH"
# Deploying costs well under 0.001 ETH; require a small cushion so the operator gets a clear message instead of a
# cryptic revert. (awk, not bash arithmetic: wei amounts overflow bash's 64-bit integers.)
if awk -v b="$BALANCE_ETH" 'BEGIN { exit !(b + 0 < 0.001) }'; then
  die "Deployer $DEPLOYER has $BALANCE_ETH ETH; needs at least 0.001 ETH (0.02 ETH to also fund the agents). Get testnet ETH from https://faucet.quicknode.com/arbitrum/sepolia and re-run."
fi

# ---- 3. build + test ------------------------------------------------------------------------
cd "$UC_CONTRACTS"
say "forge build"
forge build
say "forge test (the deploy aborts if anything is red)"
forge test

# ---- 4. deploy (and verify) -----------------------------------------------------------------
VERIFY_ARGS=()
if [ -n "$ETHERSCAN_API_KEY" ]; then
  VERIFY_ARGS=(--verify --verifier etherscan --etherscan-api-key "$ETHERSCAN_API_KEY")
  say "Deploying + verifying on Arbiscan (ETHERSCAN_API_KEY is set)"
else
  warn "ETHERSCAN_API_KEY is empty: deploying WITHOUT verification. Add a free key from https://etherscan.io/myapikey to .env and run 'pnpm verify:contract' afterwards (or it will fall back to Sourcify)."
  say "Deploying"
fi
note "This sends one transaction from $DEPLOYER and waits for the receipt (usually < 10 s on Arbitrum Sepolia)."

# The broadcast record lands in contracts/broadcast/Deploy.s.sol/421614/run-latest.json; `pnpm sync` reads it.
forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$ARBITRUM_SEPOLIA_RPC_URL" --private-key "$DEPLOYER_PRIVATE_KEY" --broadcast \
  ${VERIFY_ARGS[@]+"${VERIFY_ARGS[@]}"} -vv   # (idiom: empty array is safe under set -u on bash 3.2)

# ---- 5. report ------------------------------------------------------------------------------
RUN_LATEST="$UC_CONTRACTS/broadcast/Deploy.s.sol/$UC_CHAIN_ID/run-latest.json"
ADDR="$(cast to-check-sum-address "$(broadcast_field "$RUN_LATEST" address)")"
BLOCK="$(broadcast_field "$RUN_LATEST" block)"
TXHASH="$(broadcast_field "$RUN_LATEST" txhash)"

say "Deployed"
note "Undercloud:   $ADDR"
note "deploy block:  $BLOCK"
note "deploy tx:     $UC_EXPLORER/tx/$TXHASH"
note "contract:      $UC_EXPLORER/address/$ADDR"
if [ -n "$ETHERSCAN_API_KEY" ]; then
  note "Open the contract page and look for the green 'Contract Source Code Verified' check."
  note "If Arbiscan said 'unable to locate contract', wait ~30 s and run: pnpm verify:contract"
else
  note "Source is NOT verified yet. Run: pnpm verify:contract"
fi
echo
echo "Next: pnpm sync"
