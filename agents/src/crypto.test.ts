import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { canonicalize, commitmentOf, newSalt, publicKeyOf, encryptFor, decryptWith, sealKeyForArbiter, unsealKey } from './crypto.js'

test('commitment matches the §4 vector shared with the Solidity test', () => {
  const seller = '0x1111111111111111111111111111111111111111'
  const canon = '{"claim":"x","v":1}'
  const salt = `0x${'22'.repeat(32)}` as const
  assert.equal(commitmentOf(seller, canon, salt), '0x1d382ab8b84cb3fefe01b6f742503ca354b5bb166120a62a0eb716bd6900b7c8')
})

test('canonicalize sorts keys recursively and strips whitespace', () => {
  assert.equal(canonicalize({ z: 1, a: { y: [3, 2, 1], x: 'hi' }, n: null, b: true }), '{"a":{"x":"hi","y":[3,2,1]},"b":true,"n":null,"z":1}')
})

test('salts are 32 bytes and unique', () => {
  const a = newSalt(), b = newSalt()
  assert.equal(a.length, 66)
  assert.notEqual(a, b)
})

test('ECIES round trip with a viem one-time key', () => {
  const pk = generatePrivateKey()
  const pub = privateKeyToAccount(pk).publicKey
  assert.equal(pub, publicKeyOf(pk))
  assert.equal(pub.length, 132)
  assert.ok(pub.startsWith('0x04'))
  const plaintext = JSON.stringify({ canon: '{"claim":"x","v":1}', salt: newSalt() })
  const ct = encryptFor(pub, plaintext)
  assert.equal(decryptWith(pk, ct), plaintext)
  assert.throws(() => decryptWith(generatePrivateKey(), ct))
})

test('sealed purchase key round trip re-derives the purchase pubkey', () => {
  const arbiterPk = generatePrivateKey()
  const arbiterPub = privateKeyToAccount(arbiterPk).publicKey
  const purchasePk = generatePrivateKey()
  const sealed = sealKeyForArbiter(arbiterPub, purchasePk)
  assert.equal((sealed.length - 2) / 2, 129)
  const recovered = unsealKey(arbiterPk, sealed)
  assert.equal(recovered, purchasePk)
  assert.equal(privateKeyToAccount(recovered).publicKey, privateKeyToAccount(purchasePk).publicKey)
  assert.throws(() => unsealKey(generatePrivateKey(), sealed))
})
