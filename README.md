# Undercloud

A sealed on-chain market for compute-capacity intelligence. Autonomous agents buy and sell facts about the GPU market (a block coming off contract, a price about to move, a site going live) that the buyer cannot inspect before paying. Arbitrum Sepolia.

> Every provider, site and company in this deployment is synthetic. The contract refuses any listing without the `SYNTHETIC` attestation bit. No GPU-hours are traded, only facts about them. Testnet only.

| | |
|---|---|
| Contract (verified) | [`0xb24cA3C97Cc483aF9c1bB24b9D89F2C7461312eb`](https://sepolia.arbiscan.io/address/0xb24cA3C97Cc483aF9c1bB24b9D89F2C7461312eb) on Arbitrum Sepolia (chain 421614) |
| Dashboard | https://web-five-gules-93.vercel.app/ |
| Demo video | `<FILL: video URL>` |
| Source | https://github.com/Veer2906/undercloud |

## Chosen vertical

Compute-capacity intelligence: the layer under the GPU price boards.

I'd been reading about the compute space for a while, and while researching a company called Orn that works on compute-related products, it clicked that the interesting thing to trade isn't the GPU-hour itself (you can benchmark a server, so it's a normal rental) but the information around it: which 512-H100 block frees up next month, which provider is about to cut on-demand pricing, which site goes live early. That information is worth real money to whoever is shopping (a 512-GPU block is roughly a million dollars a month and clears in hours), it can't be shown before it's paid for, and today it has no channel: brokers want the whole deal and expert networks want an hour, not a sentence. Putting it on-chain with bonds and a committed judge felt like the right spin.

Participants in the demo:

| Role | Agent | What it does |
|---|---|---|
| Seller | **Scout** | An insider with one pre-public fact. Lists a sealed dossier, delivers on purchase. |
| Buyer | **Brineholt Labs** | An AI lab's procurement agent. Buys US H100/H200/B200/GB200 blocks on InfiniBand or NVLink under a price cap. |
| Buyer | **Sounding Compute** | A GPU broker's sourcing agent. Buys EU and APAC capacity, price moves and demand signals. |
| Arbiter | **Judge** | Operator-run Claude judge. Model id and rubric hash are immutable in the contract. Rules only on disputes. |

Most compute intel surfaces later on a predictable horizon (a marketplace listing, a provider price page, press), so every listing names a resolution source and a `resolveBy` date, and the seller's bond stays locked until then.

## Trust assumptions

1. **One committed arbiter.** A single key runs Claude (`claude-opus-5`) with a rubric whose keccak256 is fixed in the contract, and publishes provider-redacted reasons on-chain. Auditable, not trustless. A colluding buyer and arbiter can extract at most half the price per deal; a silent arbiter results in a no-fault unwind that is counted as `unadjudicated`, never as a win.
2. **Sequencer time.** All deadlines use `block.timestamp`. Demo windows are 90 s / 180 s / 600 s; production would be 48 h / 24 h / 7 d.
3. **The contract never sees plaintext.** The commitment proves substitution and non-delivery; garbage that hashes correctly is caught only by the arbiter.
4. **Nobody verifies the GPUs exist.** The market prices the credibility of a claim about capacity, not the capacity.
5. **Ethereum Sepolia has a published end-of-life of 2026-09-30**, so explorer links may degrade after that.

## Biggest design decision

Sealed-key disputes instead of public reveal. The obvious way to settle "was it worth it" is to make the buyer publish the dossier and let everyone judge. In this market that would put a provider's unannounced price cut or a tenant's contract end on a public chain forever as the cost of a quarrel. So the buyer reveals its one-time decryption key encrypted to the arbiter only; the arbiter checks that key against the on-chain purchase key, checks the hash, applies the rubric, and rules. The only things that ever reach the chain are a provider-free label, ciphertext, a sealed key, a reason code and redacted reasons. The cost is that rulings are checkable by the operator, not by the public. Paired with it: the seller's bond stays locked until the date the seller itself said the fact would surface, and a `DidNotHappen` dispute exists until then.

## One important limitation

The market prices credibility, not capacity. Nobody verifies that the GPUs exist or that the block is actually free; a well-crafted fabrication that is specific, label-consistent and not yet on any board passes the judge. Reputation is per address, so a refuted seller can start over with a fresh key. And coarse label buckets reduce, but do not remove, the chance that "2,048 H200, US-East, InfiniBand, live in November" identifies a site.

## How a trade works

1. **Commit and bond.** Seller posts `keccak256(seller, canonicalDossierJson, salt)`, a provider-free label (accelerator, GPU-count bucket, region, interconnect, price band, availability months, resolution source, `resolveBy`), a price, and a bond of 2x price.
2. **Pay blind.** A buyer agent scores the label against its thesis and the seller's on-chain counters, generates a fresh one-time key, and pays the exact price into escrow.
3. **Sealed delivery.** Seller encrypts `{dossier, salt}` to that key (ECIES) and puts the ciphertext in calldata. Buyer decrypts locally and checks the hash.
4. **Quality window.** The buyer runs mechanical checks (label consistency, forbidden content, public-record lookup) and may dispute with a bond of half the price. Otherwise the price releases to the seller minus a 2% burn; the bond stays locked until `resolveBy`.
5. **Ruling.** Buyer wins: refund + dispute bond + half the price in damages, the rest of the bond burned. Seller wins: seller takes the dispute bond.
6. **Timeouts.** Seller never delivers: buyer refunded plus 10% of the bond. Arbiter never rules: no-fault split, counted as unadjudicated.

## Other design decisions

- **Money.** Bond = 2x price. Dispute bond = ceil(price/2). Fee = 2% of price, burned. Buyer-wins burn = 1.5x price. Payouts are push-then-pull so a counterparty that rejects ETH can never block a settlement.
- **Reputation is counts, not a score.** Per seller: listed, sold, settled, confirmed, refuted, disputesWon, unadjudicated, ghosted, volume. Per buyer: bought, disputesFiled, disputesLost. Unchallenged is not confirmed.
- **Dispute reasons.** `NotAsCommitted`, `NotAsLabeled`, `AlreadyPublic`, `Incoherent`, `ForbiddenContent`, `DidNotHappen`. The first five are available inside the quality window; the last only after release, until `resolveBy`.
- **Forbidden content.** A dossier containing credentials, NDA'd contract text or provider-staff contact data is slashed even if true. The market will not be a fence for stolen access.
- **Listing categories.** `CapacityRelease`, `NewSupply`, `PriceMove`, `DemandSignal`, `ProviderReference`, each with a fixed claim-type menu. Two of them never surface publicly, and their labels say so.
- **Attestations required by the contract.** `NO_NDA`, `NO_CREDENTIALS`, `PROVIDER_LEVEL_ONLY`, `SYNTHETIC`.
- **Judge with a fallback.** With `ANTHROPIC_API_KEY` set, the agents' reasoning is model-written and the ruling says `claude-opus-5`; without it, the same mechanical rules decide and the ruling says `deterministic`. Outcomes are identical because the demo's fraud cases trip mechanical checks.
- **Re-runnable demo.** Each run uses fresh salts and a fresh per-run scout identity derived from the treasury key.

## Stack

- **Contract:** Solidity 0.8.34, one file, no imports, no owner, no upgrades. Foundry 1.8.1; 28 tests including value-conservation fuzzing and an adversarial suite. [`contracts/src/Undercloud.sol`](contracts/src/Undercloud.sol), rubric at [`contracts/rubric.md`](contracts/rubric.md).
- **Agents:** TypeScript on Node 22 with viem 2, eciesjs (secp256k1 ECIES, so a buyer's one-time Ethereum key is also its decryption key), zod, and the Anthropic SDK. [`agents/`](agents/).
- **Dashboard:** Next.js 16 with viem, no wallet needed; it rebuilds every deal from contract events. [`web/`](web/), deployed on Vercel.
- **Chain:** Arbitrum Sepolia (421614), verified on Arbiscan via the Etherscan API.

## Run it

```bash
pnpm install && pnpm keygen   # five burner keys into .env; prints the deployer address to fund
pnpm bridge                   # optional: bridge mined Ethereum Sepolia ETH to Arbitrum Sepolia
pnpm test:contracts           # forge test
pnpm deploy:contract          # deploy + verify, then: pnpm sync
pnpm fund                     # top up the agent wallets from the deployer
pnpm demo                     # two scenes on-chain (~2.5 min): a sale, then a dispute
pnpm demo:full                # six scenes (~6 min): adds forbidden content, ghost seller, bond unlock, delist
pnpm sweep                    # withdraw unlocked bonds from past runs
pnpm web                      # dashboard at http://localhost:3000
```

Local rehearsal without testnet ETH: see [`agents/.env.local.example`](agents/.env.local.example) (Anvil with `--chain-id 421614`).

## Prior art

[Erasure](https://github.com/erasureprotocol/erasure-protocol) (stake plus hashed track record; its griefing model is negative-sum, so this uses bonded, adjudicated disputes instead), [Arkham Intel Exchange](https://info.arkm.com/announcements/arkham-intel-exchange) (staked hunters, strict content rules), the [Kleros ERC-792 escrow](https://github.com/kleros/erc-792) state machine, [UMA's optimistic oracle](https://docs.uma.xyz/protocol-overview/how-does-umas-oracle-work) for the optimistic default, and [Arrow's information paradox](https://en.wikipedia.org/wiki/Arrow_information_paradox), which is the whole problem. Market context: [SF Compute](https://sfcompute.com) and [Shadeform](https://shadeform.com) are where a capacity release actually surfaces; [Silicon Data's H100 index](https://www.silicondata.com/products/silicon-index/h100) and [CME compute futures](https://www.cmegroup.com/media-room/press-releases/2026/8/11/cme_group_and_silicondatatolaunchcomputefuturesonoctober5tounloc.html) are the price boards.

## A note

This was my first project that actually touches a chain. I picked Arbitrum because I'd read the whitepaper and wanted to see the rollup from the inside, and I learn best by building. Getting testnet ETH took longer than deploying the contract, which is how I learned what token maxing really means.

## License

Apache-2.0. See [LICENSE](LICENSE).
