'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { api } from '@/lib/api'
import { useTheme, getT } from '@/lib/theme'

const mono = { fontFamily: 'monospace' }
/** Narrow rail (VS Code secondary sidebar style). */
const COLLAPSED_W = 44
const EXPANDED_W = 400

const SK_EXPANDED = 'appcloud_ai_dock_expanded'
const SK_LOG = 'appcloud_ai_chat_log'

function loadLog() {
  try {
    const raw = sessionStorage.getItem(SK_LOG)
    if (raw) {
      const v = JSON.parse(raw)
      if (Array.isArray(v)) return v
    }
  } catch {}
  return []
}

function saveLog(log) {
  try {
    sessionStorage.setItem(SK_LOG, JSON.stringify(log.slice(-80)))
  } catch {}
}

export default function AiAssistantPanel({ onReserveRight }) {
  const { theme } = useTheme()
  const t = getT(theme)
  const [expanded, setExpanded] = useState(false)
  const [status, setStatus] = useState(null)
  const [loadingStatus, setLoadingStatus] = useState(false)
  const [chatLog, setChatLog] = useState([])
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState('')
  const scrollRef = useRef(null)
  const hydrated = useRef(false)

  useEffect(() => {
    try {
      const e = sessionStorage.getItem(SK_EXPANDED)
      if (e === '1') setExpanded(true)
    } catch {}
    setChatLog(loadLog())
    hydrated.current = true
  }, [])

  useEffect(() => {
    if (!hydrated.current) return
    try {
      sessionStorage.setItem(SK_EXPANDED, expanded ? '1' : '0')
    } catch {}
  }, [expanded])

  useEffect(() => {
    saveLog(chatLog)
  }, [chatLog])

  const reserveW = expanded ? EXPANDED_W : COLLAPSED_W
  useEffect(() => {
    onReserveRight?.(reserveW)
  }, [reserveW, onReserveRight])

  const loadStatus = useCallback(async () => {
    setLoadingStatus(true)
    try {
      setStatus(await api.ai.status())
    } catch {
      setStatus(null)
    } finally {
      setLoadingStatus(false)
    }
  }, [])

  useEffect(() => {
    loadStatus()
  }, [loadStatus])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [chatLog, expanded])

  useEffect(() => {
    if (!expanded) return
    const onKey = (e) => {
      if (e.key === 'Escape') setExpanded(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [expanded])

  const send = async () => {
    if (!message.trim() || sending) return
    const userMessage = { role: 'user', content: message.trim() }
    setChatLog((prev) => [...prev, userMessage])
    setMessage('')
    setSending(true)
    setSendError('')
    try {
      const resp = await api.ai.chat([userMessage])
      const content =
        resp?.choices?.[0]?.message?.content || resp?.output || JSON.stringify(resp)
      setChatLog((prev) => [...prev, { role: 'assistant', content }])
    } catch (err) {
      setSendError(err.message || 'Failed to send')
      setChatLog((prev) => [
        ...prev,
        { role: 'assistant', content: `Error: ${err.message || 'unknown'}` },
      ])
    } finally {
      setSending(false)
    }
  }

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  const localOk = status?.local?.available
  const cloudOk = status?.cloud?.available

  return (
    <div
      style={{
        position: 'fixed',
        top: 48,
        right: 0,
        bottom: 0,
        width: reserveW,
        zIndex: 42,
        display: 'flex',
        flexDirection: 'column',
        borderLeft: `1px solid ${t.border}`,
        background: `${t.surface}f2`,
        backdropFilter: 'blur(10px)',
        boxShadow: `-6px 0 20px rgba(0,0,0,0.08)`,
        transition: 'width 0.18s ease, box-shadow 0.2s ease',
        overflow: 'hidden',
      }}
    >
      {!expanded && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          title="Open AI Assistant"
          style={{
            flex: 1,
            width: '100%',
            minHeight: 0,
            border: 'none',
            cursor: 'pointer',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'flex-start',
            gap: 14,
            padding: '16px 0',
            background: 'transparent',
            color: t.dim,
            ...mono,
          }}
        >
          <span style={{ fontSize: 18 }}>🤖</span>
          <span
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 6,
              fontSize: 9,
            }}
            title="AI backends"
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: localOk ? t.teal : t.dim,
                opacity: loadingStatus ? 0.4 : 1,
              }}
            />
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: cloudOk ? t.purple : t.dim,
                opacity: loadingStatus ? 0.4 : 1,
              }}
            />
          </span>
          <span style={{ fontSize: 11, color: t.muted, marginTop: 'auto' }}>◀</span>
        </button>
      )}

      {expanded && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            minHeight: 0,
          }}
        >
          <div
            style={{
              ...mono,
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '8px 12px',
              borderBottom: `1px solid ${t.border}`,
              fontSize: 11,
              color: t.text,
              minHeight: 40,
            }}
          >
            <span style={{ fontWeight: 700 }}>AI</span>
            <span style={{ color: t.dim, fontSize: 10 }}>
              L{localOk ? '●' : '○'} C{cloudOk ? '●' : '○'}
            </span>
            <button
              type="button"
              onClick={loadStatus}
              disabled={loadingStatus}
              style={{
                ...mono,
                fontSize: 9,
                padding: '4px 8px',
                borderRadius: 4,
                border: `1px solid ${t.border}`,
                background: t.surface2,
                color: t.dim,
                cursor: loadingStatus ? 'wait' : 'pointer',
              }}
            >
              ↻
            </button>
            <button
              type="button"
              onClick={() => setExpanded(false)}
              title="Collapse (Esc)"
              style={{
                marginLeft: 'auto',
                ...mono,
                fontSize: 10,
                padding: '4px 8px',
                borderRadius: 4,
                border: `1px solid ${t.border}`,
                background: t.surface2,
                color: t.muted,
                cursor: 'pointer',
              }}
            >
              ▶
            </button>
          </div>

          <div
            ref={scrollRef}
            style={{
              flex: 1,
              minHeight: 0,
              overflowY: 'auto',
              padding: '10px 12px',
              ...mono,
              fontSize: 12,
            }}
          >
            {chatLog.length === 0 && (
              <div style={{ color: t.dim, fontSize: 11, lineHeight: 1.5 }}>
                Ask about infrastructure, changes, discovery, or governance.
                <br />
                Enter — send · Shift+Enter — line · Esc — collapse.
              </div>
            )}
            {chatLog.map((item, i) => (
              <div
                key={i}
                style={{
                  marginBottom: 10,
                  padding: 8,
                  borderRadius: 6,
                  background: item.role === 'user' ? `${t.teal}10` : t.surface2,
                  border: `1px solid ${t.border}`,
                }}
              >
                <div
                  style={{
                    fontSize: 9,
                    color: item.role === 'user' ? t.teal : t.purple,
                    marginBottom: 4,
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                  }}
                >
                  {item.role}
                </div>
                <div style={{ whiteSpace: 'pre-wrap', color: t.text, lineHeight: 1.45 }}>
                  {item.content}
                </div>
              </div>
            ))}
          </div>

          <div
            style={{
              flexShrink: 0,
              padding: '10px 12px 12px',
              borderTop: `1px solid ${t.border}`,
              display: 'flex',
              gap: 8,
              alignItems: 'flex-end',
            }}
          >
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={onKeyDown}
              rows={2}
              placeholder="Message…"
              disabled={sending}
              style={{
                flex: 1,
                ...mono,
                fontSize: 12,
                resize: 'none',
                borderRadius: 8,
                border: `1px solid ${t.border}`,
                background: t.surface,
                color: t.text,
                padding: '8px 10px',
                lineHeight: 1.4,
              }}
            />
            <button
              type="button"
              disabled={sending || !message.trim()}
              onClick={send}
              style={{
                ...mono,
                flexShrink: 0,
                height: 44,
                padding: '0 14px',
                borderRadius: 8,
                border: `1px solid ${t.border}`,
                background: sending ? t.surface2 : `${t.teal}22`,
                color: t.text,
                cursor: sending ? 'wait' : 'pointer',
                fontWeight: 600,
                fontSize: 11,
              }}
            >
              {sending ? '…' : 'Send'}
            </button>
          </div>
          {sendError && (
            <div
              style={{
                ...mono,
                flexShrink: 0,
                fontSize: 10,
                color: t.red,
                padding: '0 12px 10px',
              }}
            >
              {sendError}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
