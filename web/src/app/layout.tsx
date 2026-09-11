import type { Metadata } from 'next'
import { Geist, Geist_Mono, Instrument_Serif } from 'next/font/google'
import './globals.css'

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] })
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] })
const serif = Instrument_Serif({ variable: '--font-instrument-serif', subsets: ['latin'], weight: '400', style: ['normal', 'italic'] })

export const metadata: Metadata = {
  title: 'Undercloud · sealed market for compute-capacity intel (Arbitrum Sepolia, synthetic)',
  description:
    'Live dashboard for Undercloud: a sealed on-chain market where scouts sell one pre-public fact about GPU capacity (a block coming off contract, a site going live, a price move, a demand signal), procurement and sourcing agents pay blind against a commitment, and a committed Claude arbiter settles disputes. Arbitrum Sepolia testnet; every provider, site and company is synthetic; no GPU-hours are traded.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} ${serif.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-paper text-ink">{children}</body>
    </html>
  )
}
