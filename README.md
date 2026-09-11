# Undercloud

A sealed on-chain market where AI labs and GPU brokers buy pre-public facts about compute capacity.

- Contract: [`0xb24cA3C97Cc483aF9c1bB24b9D89F2C7461312eb`](https://sepolia.arbiscan.io/address/0xb24cA3C97Cc483aF9c1bB24b9D89F2C7461312eb) (Arbitrum Sepolia, verified)
- Dashboard: https://web-five-gules-93.vercel.app/
- Demo video: https://www.loom.com/share/780a6c3d48604bef905955d08229b7e7

## Stack

- Chain: Arbitrum Sepolia (chain ID 421614)
- Contract: Solidity 0.8, one file, no owner, no upgrades; Foundry for tests and deploy; verified on Arbiscan through the Etherscan API
- Agents: TypeScript, viem, ECIES encryption, Claude as the judge (with a deterministic fallback)
- Dashboard: Next.js on Vercel, reads the chain directly, no wallet needed

## Why this vertical

I've been exploring compute a lot lately, and it's becoming the most relevant market in AI.
Looking at companies like Ornn, I realized the valuable thing isn't the GPU-hour, it's knowing about capacity and prices before everyone else.
That fact can't be shown before it's paid for, which makes it the perfect thing to put on-chain with bonds and a judge.

## Trust assumptions

- One committed judge: its address, model id and rubric hash are fixed in the contract; auditable, not trustless.
- Nobody verifies the GPUs exist; the market prices the credibility of a claim, not the capacity.

## Biggest design decisions

- Built on Arbitrum Sepolia: I read the Arbitrum whitepaper and wanted to learn the rollup by shipping on it.
- Disputes reveal the buyer's decryption key to the judge only, never the dossier to the public chain.

## One important limitation

A convincing fabrication that matches its label and isn't on any price board yet passes the judge, and a refuted seller can start over with a fresh wallet.

## How a trade works

1. Seller posts a hash of the dossier, a provider-free label, and a bond of 2x the price.
2. Buyer pays blind into escrow with a one-time key.
3. Seller delivers the dossier encrypted to that key; buyer decrypts and checks the hash.
4. Buyer has a window to dispute (bond of half the price, key sealed to the judge); otherwise the seller is paid minus a 2% burn.
5. Judge rules: buyer wins gets refund plus damages and the seller's bond burns; seller wins keeps the dispute bond.
6. The seller's bond stays locked until the date the fact should have gone public.


First thing I've ever put on a chain. Getting testnet ETH took longer than deploying the contract, which is how I learned what token maxing really means.

License: Apache-2.0
