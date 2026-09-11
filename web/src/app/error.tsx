'use client'

// Route-level error boundary: a single bad on-chain label or an RPC quirk must degrade to a card, never to
// Next's blank "Application error" screen. `reset` re-renders the segment; the market hook re-syncs.
export default function ErrorBoundary({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-10 sm:px-6">
      <section className="rounded-lg border border-red/40 bg-card p-5">
        <div className="eyebrow text-red">dashboard error</div>
        <h2 className="mt-1 font-serif text-2xl text-ink">Something on this page failed to render</h2>
        <p className="mt-2 text-sm text-ink-2">
          The chain data is untouched; this is a display problem (most likely an unexpected event payload or a label that is not the
          shape the agents produce). The message below is the raw error.
        </p>
        <pre className="mt-3 whitespace-pre-wrap rounded border border-line bg-paper px-3 py-2 font-mono text-xs text-ink-2">
          {error.message}
          {error.digest ? `\n(digest ${error.digest})` : ''}
        </pre>
        <button
          type="button"
          onClick={reset}
          className="mt-4 rounded border border-line bg-paper-2 px-3 py-1.5 font-mono text-xs text-ink hover:bg-card-2"
        >
          try again
        </button>
      </section>
    </div>
  )
}
