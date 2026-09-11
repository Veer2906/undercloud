// Imported FIRST by demo.ts (ESM evaluates imports in order), so this runs before schema.ts reads the value:
// the demo compresses the buyers' class-C minimum bond lock (30 days in production) to fit the run. Default 200 s
// against the default DEMO_RESOLVE_IN of 330 s; for fast local runs (e.g. DEMO_RESOLVE_IN=90) it scales to two thirds
// of the resolve window so class-C listings still clear the buyers' floor. An explicit CLASS_C_MIN_LOCK_SECONDS wins.
const resolveIn = Number(process.env.DEMO_RESOLVE_IN ?? '330')
process.env.CLASS_C_MIN_LOCK_SECONDS ??= String(Math.min(200, Math.floor((resolveIn * 2) / 3)))
