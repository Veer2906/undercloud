// The one way agents write to the chain (spec §5.3):
//   simulateContract  -> the RPC runs the call first; a revert costs no gas and decodes to its custom error
//   writeContract     -> sign + send with the prepared request
//   waitForTransactionReceipt -> block inclusion (~1 s on Arbitrum Sepolia)
//   parseEventLogs    -> typed events from the receipt (listing ids, payouts…) without any event watching
import { BaseError, ContractFunctionRevertedError, parseEventLogs, type ContractFunctionName, type ContractFunctionArgs, type Hex } from 'viem'
import { publicClient, type Wallet } from './chain.js'
import { abi, address } from './contract.js'
import { txLine } from './say.js'

type WriteFn = ContractFunctionName<typeof abi, 'nonpayable' | 'payable'>
export type TxLog = ReturnType<typeof parseEventLogs<typeof abi>>[number]
export type TxResult = { hash: Hex; blockNumber: bigint; logs: TxLog[] }

/** Every confirmed tx of this process, in order - the recap prints them as links, grouped by listing id. */
export const txHistory: { label: string; hash: Hex; id?: bigint }[] = []
/** Hooks that see each confirmed tx's logs before its tx line prints (the demo uses one for scene banners). */
const logHooks: ((logs: TxLog[]) => void)[] = []
export const onTxLogs = (cb: (logs: TxLog[]) => void) => { logHooks.push(cb) }

export class RevertError extends Error {
  constructor(public readonly errorName: string, public readonly fn: string) {
    super(`revert ${errorName} (${fn})`)
  }
}

const idOfLogs = (logs: TxLog[]): bigint | undefined => {
  for (const l of logs) { const id = (l.args as { id?: bigint }).id; if (typeof id === 'bigint') return id }
  return undefined
}

/** Sends one contract call. The tx line reads `fn(#id)`: the id is the first argument for every call but
 *  `list`, whose id only exists once the receipt's Listed event names it. */
export async function sendTx<N extends WriteFn>(
  wallet: Wallet,
  call: { functionName: N; args: ContractFunctionArgs<typeof abi, 'nonpayable' | 'payable', N>; value?: bigint },
  explicitLabel?: string,
): Promise<TxResult> {
  const first = (call.args as readonly unknown[])[0]
  let label = explicitLabel ?? (typeof first === 'bigint' ? `${call.functionName}(#${first})` : `${call.functionName}()`)
  try {
    const { request } = await publicClient.simulateContract({
      address,
      abi,
      functionName: call.functionName,
      args: call.args,
      value: call.value,
      account: wallet.account,
    } as any)
    const hash = await wallet.client.writeContract(request as any)
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 })
    if (receipt.status !== 'success') throw new Error(`tx ${hash} reverted on-chain (${label})`)
    const logs = parseEventLogs({ abi, logs: receipt.logs })
    const id = typeof first === 'bigint' ? first : idOfLogs(logs)
    if (!explicitLabel && typeof first !== 'bigint' && id !== undefined) label = `${call.functionName}(#${id})`
    txHistory.push({ label, hash, id })
    for (const hook of logHooks) hook(logs)
    txLine(label, hash)
    return { hash, blockNumber: receipt.blockNumber, logs }
  } catch (err) {
    if (err instanceof BaseError) {
      const revert = err.walk((e) => e instanceof ContractFunctionRevertedError)
      if (revert instanceof ContractFunctionRevertedError) throw new RevertError(revert.data?.errorName ?? revert.signature ?? '?', label)
      throw new Error(`${label}: ${err.shortMessage}`)
    }
    throw err
  }
}
