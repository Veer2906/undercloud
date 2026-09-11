# Undercloud

A sealed on-chain market where AI labs and GPU brokers buy pre-public facts about compute capacity.

- Contract: [`0xb24cA3C97Cc483aF9c1bB24b9D89F2C7461312eb`](https://sepolia.arbiscan.io/address/0xb24cA3C97Cc483aF9c1bB24b9D89F2C7461312eb) (Arbitrum Sepolia, verified)
- Dashboard: https://web-five-gules-93.vercel.app/
- Demo video: https://www.loom.com/share/780a6c3d48604bef905955d08229b7e7

## Stack

- Chain: Arbitrum Sepolia (chain ID 421614)
- Contract: Solidity 0.8, one file, no owner, no upgrades; Foundry for tests and deploy; verified on Arbiscan through the Etherscan API
- Dashboard: Next.js on Vercel

## Why this vertical

I've been exploring compute a lot lately, and it's becoming the most relevant market in AI.
Looking at companies like Ornn, thought I would make a marketplace selling compute information.

## Trust assumptions

- One committed judge: its address, model id and rubric hash are fixed in the contract.
- Nobody verifies the GPUs exist; the market prices the credibility of a claim, not the capacity.

## Biggest design decisions

- Built on Arbitrum Sepolia: I read the Arbitrum whitepaper and wanted to learn how it works by shipping on it (personally how I learn new tech).
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


First thing I've ever put on a chain, took a bit but was fun + learnt what token maxxxing really meant.

License: Apache-2.0
