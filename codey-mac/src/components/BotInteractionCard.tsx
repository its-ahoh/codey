import React, { useRef, useState } from 'react'
import type { ChatMessage } from '../types'
import { apiService } from '../services/api'

/** This response bypasses the normal composer queue: other Bots may still run. */
export function BotInteractionCard({ chatId, message }: { chatId: string; message: ChatMessage }) {
  const request = message.botInteraction
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const sending = useRef(false)
  const [error, setError] = useState('')
  if (!request) return null
  if (request.status !== 'pending') return <small>{request.status === 'resolved' ? `Answered${request.answer ? `: ${request.answer}` : ''}` : 'Cancelled'}</small>
  const send = async (text: string, grant = false) => {
    // React state can lag behind consecutive events in the same batch.
    if (sending.current) return
    sending.current = true
    setBusy(true)
    setError('')
    try {
      if (grant && request.permissionTools?.length) {
        const result = await window.codey.permissions.addAllowed(request.permissionTools, chatId)
        if (!result.ok) throw new Error(result.error || 'Permission could not be saved')
      }
      await apiService.chats.send(chatId, text, undefined, { interactionId: request.id })
    } catch (err) { setError((err as Error).message) }
    finally { sending.current = false; setBusy(false) }
  }
  return <section aria-label={`Waiting for your response: ${request.bot}`} style={{ padding: 12, border: '1px solid currentColor', borderRadius: 8, margin: '8px 0' }}>
    <strong>{request.bot} · {request.scope === 'team' ? 'Team waiting' : 'Waiting for you'}</strong>
    <p>{request.question}</p>
    {!!request.permissionTools?.length && <div>
      <p>Requested tools: {request.permissionTools.join(', ')}</p>
      <button disabled={busy} onClick={() => void send('The requested permissions have been granted. Continue your task.', true)}>Allow and continue</button>
      <button disabled={busy} onClick={() => void send('Permission denied. Do not retry the denied actions; explain an alternative.')}>Deny</button>
    </div>}
    {!request.permissionTools?.length && request.choices?.map(choice => <button key={choice} disabled={busy} onClick={() => void send(choice)}>{choice}</button>)}
    <form onSubmit={event => { event.preventDefault(); if (answer.trim()) void send(answer) }}>
      <input aria-label={`Reply to ${request.bot}`} value={answer} onChange={event => setAnswer(event.target.value)} disabled={busy} placeholder="Reply to this Bot" />
      <button disabled={busy || !answer.trim()} type="submit">Reply</button>
    </form>
    {error && <p role="alert">{error}</p>}
  </section>
}
