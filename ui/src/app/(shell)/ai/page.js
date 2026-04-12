'use client'

import { useEffect } from 'react'

/** Legacy /ai URL → Integrations (AI assistant section). */
export default function AIRedirectPage() {
  useEffect(() => {
    window.location.replace('/integrations#ai-assistant')
  }, [])
  return (
    <div style={{ padding: 24, fontFamily: 'monospace', fontSize: 12, color: '#94a3b8' }}>
      Redirecting to Integrations…
    </div>
  )
}
