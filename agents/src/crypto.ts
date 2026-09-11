// Canonicalization, commitment and encryption helpers shared by every agent (spec §5.2).
//
//   commitment = keccak256(abi.encode(seller, canonicalDossierJson, salt))   -- what the seller posts on-chain
//   ciphertext = ECIES(buyerOneTimePubKey, JSON.stringify({ canon, salt }))   -- what the seller delivers
//   sealedKey  = ECIES(arbiterPubKey, buyerOneTimePrivKey)                    -- what a disputing buyer reveals
//
// ECIES here is eciesjs 0.5.0: secp256k1 ECDH + HKDF-SHA256 + AES-256-GCM. A viem account's 65-byte
// uncompressed public key (0x04…) is accepted directly as the recipient key.
import { keccak256, toHex, hexToBytes, encodeAbiParameters, type Hex, type Address } from 'viem'
import { encrypt, decrypt, PrivateKey } from 'eciesjs'
import { randomBytes } from 'node:crypto'

/** Deterministic JSON: sorted object keys, no whitespace. Same object → same bytes → same keccak.
 *  With the dossier value rules (strings, integers, booleans, string arrays, null - never floats)
 *  this is byte-identical to RFC 8785 (JCS) output. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  const keys = Object.keys(value as Record<string, unknown>).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`).join(',')}}`
}

/** 32 random bytes as hex; one fresh salt per listing (fresh salt → fresh commitment → re-runnable demo). */
export function newSalt(): Hex {
  return toHex(randomBytes(32))
}

/** The on-chain commitment: keccak256(abi.encode(address seller, string canon, bytes32 salt)).
 *  Binding the seller address stops anyone re-listing someone else's ciphertext; the salt stops
 *  dictionary attacks on short dossiers. Solidity computes the identical value (contract test 11). */
export function commitmentOf(seller: Address, canon: string, salt: Hex): Hex {
  return keccak256(
    encodeAbiParameters([{ type: 'address' }, { type: 'string' }, { type: 'bytes32' }], [seller, canon, salt]),
  )
}

/** Uncompressed secp256k1 public key (0x04…, 65 bytes) for an Ethereum private key. */
export function publicKeyOf(privateKey: Hex): Hex {
  return `0x${PrivateKey.fromHex(privateKey.slice(2)).publicKey.toHex(false)}`
}

/** ECIES to a 65-byte public key - only the holder of the matching private key can read it. */
export function encryptFor(recipientPublicKey: Hex, plaintext: string): Hex {
  return toHex(encrypt(recipientPublicKey.slice(2), new TextEncoder().encode(plaintext)))
}

export function decryptWith(privateKey: Hex, ciphertext: Hex): string {
  return new TextDecoder().decode(decrypt(privateKey.slice(2), hexToBytes(ciphertext)))
}

/** A disputing buyer reveals its one-time purchase key ONLY to the arbiter: the 32 raw key bytes,
 *  ECIES-encrypted to the arbiter's public key (129 bytes on the wire). Never plaintext on-chain. */
export function sealKeyForArbiter(arbiterPubKey: Hex, purchasePrivKey: Hex): Hex {
  return toHex(encrypt(arbiterPubKey.slice(2), hexToBytes(purchasePrivKey)))
}

/** Arbiter side: recover the buyer's one-time private key from the sealed blob. Throws on garbage. */
export function unsealKey(arbiterPrivKey: Hex, sealed: Hex): Hex {
  const raw = decrypt(arbiterPrivKey.slice(2), hexToBytes(sealed))
  if (raw.length !== 32) throw new Error(`sealed key decrypted to ${raw.length} bytes, expected 32`)
  return toHex(raw)
}
