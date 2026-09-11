#!/usr/bin/env bash
# Bridge Ethereum Sepolia ETH -> Arbitrum Sepolia for the DEPLOYER wallet, with no wallet app.
# Usage: pnpm bridge [amount_in_eth]   (default: everything on L1 minus a small gas reserve)
# Arbitrum's Delayed Inbox.depositEth() credits the SAME address on Arbitrum Sepolia ~10-15 min later.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; [ -f .env ] && source .env; set +a
: "${DEPLOYER_PRIVATE_KEY:?DEPLOYER_PRIVATE_KEY missing - run: pnpm keygen}"
: "${DEPLOYER_ADDRESS:?DEPLOYER_ADDRESS missing - run: pnpm keygen}"

L1_RPC="${SEPOLIA_RPC_URL:-https://ethereum-sepolia-rpc.publicnode.com}"
L2_RPC="${ARBITRUM_SEPOLIA_RPC_URL:-https://sepolia-rollup.arbitrum.io/rpc}"
INBOX=0xaAe29B0366299461418F5324a79Afc425BE5ae21   # Arbitrum Sepolia Delayed Inbox on Ethereum Sepolia (docs.arbitrum.io contract addresses)
RESERVE_ETH=0.004                                   # left on L1 to pay for this transaction

l1_chain=$(cast chain-id --rpc-url "$L1_RPC")
[ "$l1_chain" = "11155111" ] || { echo "L1 RPC $L1_RPC is chain $l1_chain, expected Ethereum Sepolia (11155111)"; exit 1; }

l1_bal=$(cast balance "$DEPLOYER_ADDRESS" --rpc-url "$L1_RPC")
l2_bal=$(cast balance "$DEPLOYER_ADDRESS" --rpc-url "$L2_RPC")
echo "deployer          $DEPLOYER_ADDRESS"
echo "Ethereum Sepolia  $(cast from-wei "$l1_bal") ETH"
echo "Arbitrum Sepolia  $(cast from-wei "$l2_bal") ETH"

if [ "$l1_bal" = "0" ]; then
  cat <<MSG

No Ethereum Sepolia ETH on the deployer yet. Get some with a proof-of-work faucet (no account needed):
  1. https://sepolia-faucet.pk910.de/        paste $DEPLOYER_ADDRESS, press Start Mining, wait until >= 0.05 ETH, press Stop & claim
  2. https://openfaucet.org/ethereum-sepolia  same idea (0.002 ETH per proof, claims 0.01-0.05 ETH)
Then run:  pnpm bridge
MSG
  exit 1
fi

reserve=$(cast to-wei "$RESERVE_ETH" ether)
if [ $# -ge 1 ]; then amount=$(cast to-wei "$1" ether); else amount=$(python3 -c "print(max(0, $l1_bal - $reserve))"); fi
min=$(cast to-wei 0.01 ether)
if python3 -c "import sys; sys.exit(0 if $amount < $min else 1)"; then
  echo "Only $(cast from-wei "$l1_bal") ETH on L1; need at least ~0.015 ETH (0.01 to bridge + gas). Mine a bit more, then retry."; exit 1
fi

echo
echo "Bridging $(cast from-wei "$amount") ETH via Inbox.depositEth() ..."
tx=$(cast send "$INBOX" "depositEth()" --value "$amount" --private-key "$DEPLOYER_PRIVATE_KEY" --rpc-url "$L1_RPC" --json | python3 -c "import json,sys; print(json.load(sys.stdin)['transactionHash'])")
echo "L1 tx: https://sepolia.etherscan.io/tx/$tx"
echo "It lands on Arbitrum Sepolia at the same address in ~10-15 minutes: https://sepolia.arbiscan.io/address/$DEPLOYER_ADDRESS"
echo "Check with:  pnpm balance"
