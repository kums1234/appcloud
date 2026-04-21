'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { api } from '@/lib/api'
import { useTheme, getT } from '@/lib/theme'

const mono = { fontFamily: 'monospace' }
const COLLAPSED_H = 56
const EXPANDED_H = 420

// Lightweight markdown-to-HTML for chat responses (no external deps).
// Handles: ## headings, **bold**, *italic*, `code`, tables, > blockquotes, - lists
function renderMarkdown(text) {
  if (!text) return ''
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  const lines = escaped.split('\n')
  const out = []
  let inTable = false
  let tableRows = []

  const flushTable = () => {
    if (!tableRows.length) return
    // First row = header, second = separator (skip), rest = body
    const header = tableRows[0]
    const body = tableRows.slice(2) // skip separator row
    let t = '<table style="width:100%;border-collapse:collapse;margin:8px 0;font-size:11px">'
    t += '<thead><tr>'
    for (const cell of parseCells(header)) {
      t += `<th style="text-align:left;padding:4px 8px;border-bottom:1px solid var(--c-border,#1e293b);font-weight:700;white-space:nowrap">${inline(cell)}</th>`
    }
    t += '</tr></thead><tbody>'
    for (const row of body) {
      t += '<tr>'
      for (const cell of parseCells(row)) {
        t += `<td style="padding:3px 8px;border-bottom:1px solid var(--c-border,#1e293b);opacity:0.85">${inline(cell)}</td>`
      }
      t += '</tr>'
    }
    t += '</tbody></table>'
    out.push(t)
    tableRows = []
  }

  const parseCells = (row) =>
    row.split('|').map(c => c.trim()).filter(c => c && !/^[-:]+$/.test(c))

  const inline = (s) => s
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code style="background:rgba(255,255,255,0.06);padding:1px 4px;border-radius:3px;font-size:10px">$1</code>')

  for (const line of lines) {
    const trimmed = line.trim()

    // Table rows
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      if (!inTable) inTable = true
      tableRows.push(trimmed)
      continue
    } else if (inTable) {
      flushTable()
      inTable = false
    }

    // Separator lines (---) — skip as horizontal rule
    if (/^[-]{3,}$/.test(trimmed)) {
      continue
    }

    // Headings
    if (trimmed.startsWith('## ')) {
      out.push(`<div style="font-size:13px;font-weight:800;margin:12px 0 6px;letter-spacing:-0.01em">${inline(trimmed.slice(3))}</div>`)
      continue
    }
    if (trimmed.startsWith('# ')) {
      out.push(`<div style="font-size:14px;font-weight:800;margin:14px 0 6px;letter-spacing:-0.01em">${inline(trimmed.slice(2))}</div>`)
      continue
    }

    // Blockquotes
    if (trimmed.startsWith('&gt; ')) {
      out.push(`<div style="border-left:3px solid var(--c-border,#334155);padding:6px 12px;margin:6px 0;font-size:11px;opacity:0.9;line-height:1.5">${inline(trimmed.slice(5))}</div>`)
      continue
    }

    // List items
    if (/^[-*] /.test(trimmed)) {
      out.push(`<div style="padding-left:12px;margin:2px 0">• ${inline(trimmed.slice(2))}</div>`)
      continue
    }

    // Empty lines → small spacer
    if (!trimmed) {
      out.push('<div style="height:4px"></div>')
      continue
    }

    // Regular paragraph
    out.push(`<div style="margin:2px 0;line-height:1.5">${inline(trimmed)}</div>`)
  }
  if (inTable) flushTable()
  return out.join('')
}

const SK_EXPANDED = 'appcloud_cmd_expanded'
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

export default function CommandBar() {
  const { theme } = useTheme()
  const T = getT(theme)

  const [expanded, setExpanded] = useState(false)
  const [status, setStatus] = useState(null)
  const [chatLog, setChatLog] = useState([])
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState('')
  const scrollRef = useRef(null)
  const inputRef = useRef(null)
  const hydrated = useRef(false)

  // Hydrate from sessionStorage
  useEffect(() => {
    try {
      if (sessionStorage.getItem(SK_EXPANDED) === '1') setExpanded(true)
    } catch {}
    setChatLog(loadLog())
    hydrated.current = true
  }, [])

  useEffect(() => {
    if (!hydrated.current) return
    try { sessionStorage.setItem(SK_EXPANDED, expanded ? '1' : '0') } catch {}
  }, [expanded])

  useEffect(() => { saveLog(chatLog) }, [chatLog])

  // Load AI status
  const loadStatus = useCallback(async () => {
    try { setStatus(await api.ai.status()) } catch { setStatus(null) }
  }, [])
  useEffect(() => { loadStatus() }, [loadStatus])

  // Auto-scroll chat
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chatLog, expanded])

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e) => {
      // Cmd+K or Ctrl+K to focus
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setExpanded(true)
        setTimeout(() => inputRef.current?.focus(), 50)
      }
      // Escape to collapse
      if (e.key === 'Escape' && expanded) {
        setExpanded(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [expanded])

  const send = async () => {
    if (!message.trim() || sending) return
    const userMessage = { role: 'user', content: message.trim() }
    setChatLog(prev => [...prev, userMessage])
    setMessage('')
    setSending(true)
    setSendError('')
    try {
      const resp = await api.ai.chat([userMessage])
      const content = resp?.choices?.[0]?.message?.content || resp?.output || JSON.stringify(resp)
      setChatLog(prev => [...prev, { role: 'assistant', content }])
    } catch (err) {
      setSendError(err.message || 'Failed to send')
      setChatLog(prev => [...prev, { role: 'assistant', content: `Error: ${err.message || 'unknown'}` }])
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

  const barHeight = expanded ? EXPANDED_H : COLLAPSED_H

  return (
    <div style={{
      position: 'fixed', bottom: 0, left: 56, right: 0,
      height: barHeight, zIndex: 45,
      background: `${T.surface}f5`,
      backdropFilter: 'blur(12px)',
      borderTop: `1px solid ${T.border}`,
      boxShadow: `0 -4px 24px rgba(0,0,0,0.12)`,
      display: 'flex', flexDirection: 'column',
      transition: 'height 0.22s ease',
      overflow: 'hidden',
    }}>

      {/* Chat log (visible when expanded) */}
      {expanded && (
        <div ref={scrollRef} style={{
          flex: 1, minHeight: 0, overflowY: 'auto',
          padding: '14px 20px 8px', ...mono, fontSize: 12,
        }}>
          {chatLog.length === 0 && (
            <div style={{ color: T.dim, fontSize: 11, lineHeight: 1.6, padding: '8px 0' }}>
              Ask about infrastructure, risks, changes, or governance.
              <br />
              <span style={{ fontSize: 9, color: T.muted }}>
                Enter — send · Shift+Enter — newline · Esc — collapse · Cmd+K — focus
              </span>
            </div>
          )}
          {chatLog.map((item, i) => (
            <div key={i} style={{
              marginBottom: 10, padding: '10px 14px', borderRadius: 8,
              background: item.role === 'user' ? `${T.teal}10` : T.surface2,
              border: `1px solid ${item.role === 'user' ? T.teal + '22' : T.border}`,
            }}>
              <div style={{
                fontSize: 9, fontWeight: 700,
                color: item.role === 'user' ? T.teal : T.purple,
                marginBottom: 4, textTransform: 'uppercase',
                letterSpacing: '0.06em',
              }}>
                {item.role}
              </div>
              {item.role === 'assistant' ? (
                <div
                  style={{ color: T.text, lineHeight: 1.5, fontSize: 11 }}
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(item.content) }}
                />
              ) : (
                <div style={{ whiteSpace: 'pre-wrap', color: T.text, lineHeight: 1.5 }}>
                  {item.content}
                </div>
              )}
            </div>
          ))}
          {sending && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0' }}>
              <span style={{
                display: 'inline-block', width: 12, height: 12, borderRadius: '50%',
                border: `2px solid ${T.border2}`, borderTopColor: T.teal,
                animation: 'spin .7s linear infinite',
              }} />
              <span style={{ fontSize: 10, color: T.dim }}>Thinking...</span>
            </div>
          )}
        </div>
      )}

      {/* Input row */}
      <div style={{
        flexShrink: 0, height: COLLAPSED_H,
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '0 20px',
        borderTop: expanded ? `1px solid ${T.border}` : 'none',
      }}>
        {/* AI status indicators */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <div style={{
            width: 7, height: 7, borderRadius: '50%',
            background: localOk ? T.teal : T.dim,
            boxShadow: localOk ? `0 0 6px ${T.teal}` : 'none',
          }} title={`Local AI: ${localOk ? 'online' : 'offline'}`} />
          <div style={{
            width: 7, height: 7, borderRadius: '50%',
            background: cloudOk ? T.purple : T.dim,
            boxShadow: cloudOk ? `0 0 6px ${T.purple}` : 'none',
          }} title={`Cloud AI: ${cloudOk ? 'online' : 'offline'}`} />
        </div>

        {/* Prompt character */}
        <span style={{ ...mono, fontSize: 14, color: T.teal, fontWeight: 700, flexShrink: 0 }}>{'>'}</span>

        {/* Input */}
        <input
          ref={inputRef}
          type="text"
          value={message}
          onChange={e => setMessage(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => !expanded && setExpanded(true)}
          placeholder="Ask about infrastructure, risks, or changes..."
          disabled={sending}
          style={{
            flex: 1, ...mono, fontSize: 13,
            background: 'transparent', border: 'none', outline: 'none',
            color: T.text, padding: '8px 0',
            caretColor: T.teal,
          }}
        />

        {sendError && (
          <span style={{ ...mono, fontSize: 9, color: T.red, flexShrink: 0 }}>
            {sendError}
          </span>
        )}

        {/* Send button */}
        <button
          type="button"
          disabled={sending || !message.trim()}
          onClick={send}
          style={{
            ...mono, flexShrink: 0, fontSize: 10, fontWeight: 700,
            padding: '6px 14px', borderRadius: 6,
            border: `1px solid ${T.border}`,
            background: message.trim() ? `${T.teal}22` : 'transparent',
            color: message.trim() ? T.teal : T.dim,
            cursor: sending ? 'wait' : message.trim() ? 'pointer' : 'default',
            transition: 'all 0.15s',
          }}
        >
          {sending ? '...' : 'Send'}
        </button>

        {/* Expand/collapse toggle */}
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          title={expanded ? 'Collapse (Esc)' : 'Expand'}
          style={{
            ...mono, flexShrink: 0, fontSize: 11,
            width: 28, height: 28, borderRadius: 6,
            border: `1px solid ${T.border}`,
            background: 'transparent',
            color: T.dim, cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'all 0.15s',
          }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = `${T.teal}44`; e.currentTarget.style.color = T.teal }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.color = T.dim }}
        >
          {expanded ? '▼' : '▲'}
        </button>
      </div>

      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  )
}
