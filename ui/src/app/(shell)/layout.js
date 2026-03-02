import Sidebar from '@/components/layout/Sidebar'

export default function ShellLayout({ children }) {
  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: '#04080f' }}>
      <Sidebar />
      <main style={{ marginLeft: 220, flex: 1, minHeight: '100vh', overflowX: 'hidden' }}>
        {children}
      </main>
    </div>
  )
}