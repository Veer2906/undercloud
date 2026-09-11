import Dashboard from '@/components/Dashboard'

// Server shell: the live market is a client component (it polls the chain).
export default function Home() {
  return (
    <div className="flex flex-1 flex-col">
      <Dashboard />
    </div>
  )
}
