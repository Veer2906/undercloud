import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadDossiers, loadPublicRecord } from './data.js'
import { bandOf, bucketOf, findPriorPublicRecord, forbiddenContentScan, labelPayloadConsistency, mechanicalGround, redactNames, PayloadSchema, VERIFIABILITY_CLASS } from './schema.js'

const dossiers = loadDossiers()
const records = loadPublicRecord()
const entry = (id: string) => dossiers.find((d) => d.id === id)!
const LISTED_AT = BigInt(Math.floor(Date.parse('2026-09-11T08:00:00Z') / 1000))

test('forbiddenContentScan: zero hits on every honest-shaped payload', () => {
  for (const id of ['D1', 'D2', 'D4', 'D5', 'D6', 'D7', 'D8']) assert.deepEqual(forbiddenContentScan(entry(id).payload), [], id)
})

test('forbiddenContentScan: exactly the five §F.1 hits on D3, in emission order', () => {
  assert.deepEqual(forbiddenContentScan(entry('D3').payload), [
    'forbidden key $.apiKey',
    'API-key-like value at $.apiKey',
    'forbidden key $.contractExcerpt',
    'contract-language value (NDA text) at $.contractExcerpt',
    'contract-language value (section reference) at $.contractExcerpt',
  ])
})

test('forbiddenContentScan: compute prose with counts, dates and month windows never looks like a phone number', () => {
  assert.deepEqual(forbiddenContentScan({ what: '256 nodes, 8 GPUs per node, 3.2 Tb/s, 1,890 milli-USD, USD 1,200,000, window 2026-10/2027-03, 2026-09-30T00:00:00Z' }), [])
  assert.deepEqual(forbiddenContentScan({ contact: 'desk' }), ['forbidden key $.contact'])
  assert.deepEqual(forbiddenContentScan({ note: 'call +1 (415) 555-0142' }), ['phone-number-like value at $.note'])
  assert.deepEqual(forbiddenContentScan({ note: 'ops@provider.example' }), ['email-like value at $.note'])
})

test('bandOf on the eight dataset prices', () => {
  const expected: Record<string, string> = { D1: '2.00-2.49', D2: '1.50-1.99', D3: '2.50-2.99', D4: '2.00-2.49', D5: 'n/a', D6: '1.50-1.99', D7: '4.00-5.99', D8: '2.00-2.49' }
  for (const [id, band] of Object.entries(expected)) assert.equal(bandOf((entry(id).payload as any).claim.priceMilliUsdPerGpuHour), band, id)
  assert.equal(bucketOf(63), null)
  assert.equal(bucketOf(72), '64-255')
  assert.equal(bucketOf(4096), '4096+')
})

test('labelPayloadConsistency: clean on D1-D7 (window fit included), fires on D8 for accelerator and bucket', () => {
  for (const id of ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7']) assert.deepEqual(labelPayloadConsistency(entry(id).label, entry(id).payload), [], id)
  const d8 = labelPayloadConsistency(entry('D8').label, entry('D8').payload)
  assert.deepEqual(d8.map((m) => m.split(':')[0]), ['accelerator', 'bucket'])
  // A numeric price under an n/a label (outside PriceMove) and an event outside the window are mismatches.
  const d1 = entry('D1')
  assert.ok(labelPayloadConsistency({ ...d1.label, priceBand: 'n/a' }, d1.payload).some((m) => m.startsWith('priceBand')))
  assert.ok(labelPayloadConsistency({ ...d1.label, availabilityWindow: '2027-01/2027-03' }, d1.payload).some((m) => m.startsWith('availabilityWindow')))
})

test('findPriorPublicRecord: D2 trips on the price-board record; D6 and D7 do not', () => {
  assert.equal(findPriorPublicRecord(records, entry('D2').payload, LISTED_AT)?.source, 'synthetic://priceboard/eu-west/h100-on-demand/2026-08-28')
  assert.equal(findPriorPublicRecord(records, entry('D6').payload, LISTED_AT), undefined)
  assert.equal(findPriorPublicRecord(records, entry('D7').payload, LISTED_AT), undefined)
  // 90-day lookback: the same record is too old to matter a year later.
  assert.equal(findPriorPublicRecord(records, entry('D2').payload, LISTED_AT + 365n * 86400n), undefined)
})

test('mechanicalGround: rule order on the demo set', () => {
  assert.equal(mechanicalGround(entry('D1').label, entry('D1').payload, LISTED_AT, records), null)
  assert.equal(mechanicalGround(entry('D2').label, entry('D2').payload, LISTED_AT, records)?.reason, 'AlreadyPublic')
  assert.equal(mechanicalGround(entry('D3').label, entry('D3').payload, LISTED_AT, records)?.reason, 'ForbiddenContent')
  assert.equal(mechanicalGround(entry('D8').label, entry('D8').payload, LISTED_AT, records)?.reason, 'NotAsLabeled')
})

test('PayloadSchema: every payload is well-formed except D3 (extra keys); D2 and D8 are rogue by record / label, not by shape', () => {
  for (const d of dossiers) assert.equal(PayloadSchema.safeParse(d.payload).success, d.id !== 'D3', d.id)
})

test('redactNames strips provider, site and counterparties but keeps generic words', () => {
  const out = redactNames('Halyard Cloud at HLY-PDX2 (Hillsboro, OR) told the outgoing tenant (AI lab); Halyard again; the cloud provider', entry('D1').payload)
  assert.equal(out, '[provider] at [site] told the [counterparty]; [provider] again; the cloud provider')
  // site sub-tokens (city, site code, its halves) must not leak piecewise either; 2-letter state codes and lowercase words survive
  assert.equal(redactNames('the Hillsboro site (PDX2, HLY side) of Halyard, OR the target', entry('D1').payload), 'the [site] site ([site], [site] side) of [provider], OR the target')
})

test('verifiability classes', () => {
  assert.equal(VERIFIABILITY_CLASS('CapacityRelease', 'reservation-ending-within-30d'), 'A')
  assert.equal(VERIFIABILITY_CLASS('PriceMove', 'reserved-rate-change'), 'B')
  assert.equal(VERIFIABILITY_CLASS('NewSupply', 'go-live-date-set'), 'B')
  assert.equal(VERIFIABILITY_CLASS('DemandSignal', 'rfq-in-market'), 'C')
})
