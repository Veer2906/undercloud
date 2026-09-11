import { agentOf, bytesLen, fmtEth, parseLabel, reasonName, shortHex } from './format'
import type { MarketEvent } from './market'

/** One-line, human description of an event for the live feed and timeline headers. */
export function describeEvent(e: MarketEvent): { verb: string; detail: string; actor?: string; tone: 'neutral' | 'good' | 'bad' | 'warn' } {
  switch (e.eventName) {
    case 'Listed': {
      const { label } = parseLabel(e.args.label)
      // Only the coarse, provider-free block description ever reaches the feed: accelerator × bucket @ region.
      const block = label.accelerator && label.gpuCountBucket ? `${label.accelerator} × ${label.gpuCountBucket}` : ''
      const what = [block, label.region].filter(Boolean).join(' @ ') || 'label unreadable'
      return {
        verb: 'Listed',
        actor: e.args.seller,
        detail: `${what} · ${fmtEth(e.args.price)} · bond ${fmtEth(e.args.bond)} · commitment ${shortHex(e.args.contentHash, 6, 4)}`,
        tone: 'neutral',
      }
    }
    case 'Purchased':
      return {
        verb: 'Purchased',
        actor: e.args.buyer,
        detail: `paid blind; one-time key ${shortHex(e.args.buyerPubKey, 6, 4)} (${bytesLen(e.args.buyerPubKey)} bytes)`,
        tone: 'neutral',
      }
    case 'Delivered':
      return { verb: 'Delivered', detail: `ciphertext sealed to the buyer's key, ${bytesLen(e.args.ciphertext).toLocaleString()} bytes in calldata`, tone: 'neutral' }
    case 'Released':
      return { verb: 'Released', detail: `seller paid ${fmtEth(e.args.sellerPayout)}; ${fmtEth(e.args.feeBurned)} burned; bond still locked`, tone: 'good' }
    case 'Disputed':
      return {
        verb: 'Disputed',
        actor: e.args.buyer,
        detail: `${reasonName(e.args.reason)} (${e.args.afterRelease ? 'outcome, after release' : 'quality window'}); key sealed to the arbiter, ${bytesLen(e.args.sealedKey)} bytes`,
        tone: 'warn',
      }
    case 'Ruled':
      return {
        verb: e.args.buyerWins ? 'Ruled: buyer wins' : 'Ruled: seller wins',
        detail: `buyer ${fmtEth(e.args.buyerPayout)} · seller ${fmtEth(e.args.sellerPayout)} · burned ${fmtEth(e.args.burned)}`,
        tone: e.args.buyerWins ? 'bad' : 'good',
      }
    case 'Unadjudicated':
      return { verb: 'Unadjudicated', detail: `arbiter silent; no-fault unwind: buyer ${fmtEth(e.args.buyerPayout)}, seller ${fmtEth(e.args.sellerPayout)}`, tone: 'warn' }
    case 'Refunded':
      return { verb: 'Refunded', detail: `seller ghosted: buyer ${fmtEth(e.args.buyerPayout)} (price + 10% of bond), seller ${fmtEth(e.args.sellerPayout)}`, tone: 'bad' }
    case 'Attested':
      return { verb: 'Attested', detail: `buyer says it showed up on the board${e.args.evidenceURI ? ` · ${e.args.evidenceURI}` : ''} (display only)`, tone: 'good' }
    case 'BondWithdrawn':
      return { verb: 'Bond withdrawn', detail: `${fmtEth(e.args.amount)} returned to the seller after resolveBy`, tone: 'good' }
    case 'Delisted':
      return { verb: 'Delisted', detail: `bond ${fmtEth(e.args.bondReturned)} returned; never sold`, tone: 'neutral' }
    default:
      return { verb: String((e as { eventName: string }).eventName), detail: '', tone: 'neutral' }
  }
}

export function actorName(addr?: string) {
  return addr ? agentOf(addr).name : ''
}
