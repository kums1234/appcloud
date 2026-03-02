import Sidebar from '@/components/layout/Sidebar'

export default function Shell({ children }) {
  return (
    <div className="flex min-h-screen bg-surface bg-grid-pattern bg-grid">
      <Sidebar />
      <main className="ml-56 flex-1 min-h-screen">
        {children}
      </main>
    </div>
  )
}
