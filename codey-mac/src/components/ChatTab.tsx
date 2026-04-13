import React, { useState, useRef, useEffect } from 'react'
import { ChatMessage, ToolCallEntry } from '../types'
import { apiService } from '../services/api'

interface ChatTabProps {
  isGatewayRunning: boolean
  messages: ChatMessage[]
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>
}

export const ChatTab: React.FC<ChatTabProps> = ({ isGatewayRunning, messages, setMessages }) => {
  const [input, setInput] = useState('')
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [conversationId, setConversationId] = useState<string | undefined>()
  const [isSending, setIsSending] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const [agentStatus, setAgentStatus] = useState<'idle' | 'thinking' | 'working' | 'writing'>('idle')

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages])

  const sendMessage = async () => {
    if (!input.trim() || !isGatewayRunning || isSending) return;

    const userMessage: ChatMessage = {
      id: Date.now().toString(),
      role: 'user',
      content: input,
      timestamp: Date.now(),
    };

    const assistantMessageId = (Date.now() + 1).toString();

    const assistantMessage: ChatMessage = {
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      toolCalls: [],
      isComplete: false,
    };

    setMessages(prev => [...prev, userMessage, assistantMessage]);
    setInput('');
    setAgentStatus('thinking');
    setIsSending(true);

    try {
      const result = await apiService.sendMessage(
        input,
        (update) => {
          if (update.type === 'tool_start') setAgentStatus('working')
          setMessages(prev => {
            const idx = prev.findIndex(m => m.id === assistantMessageId);
            if (idx === -1) return prev;
            const entry: ToolCallEntry = {
              id: `tool-${Date.now()}-${Math.random()}`,
              type: update.type as 'tool_start' | 'tool_end' | 'info',
              tool: update.tool,
              message: update.message,
              input: update.input,
              output: update.output,
            };
            return [
              ...prev.slice(0, idx),
              { ...prev[idx], toolCalls: [...(prev[idx].toolCalls || []), entry] },
              ...prev.slice(idx + 1),
            ];
          });
        },
        (text) => {
          setAgentStatus('writing')
          setMessages(prev => {
            const idx = prev.findIndex(m => m.id === assistantMessageId);
            if (idx === -1) return prev;
            return [
              ...prev.slice(0, idx),
              { ...prev[idx], content: prev[idx].content + text },
              ...prev.slice(idx + 1),
            ];
          });
        },
        conversationId,
      );

      // Primary source: conversationId from HTTP response body (reliable)
      if (result.conversationId) setConversationId(result.conversationId);

      // Mark complete
      setAgentStatus('idle')
      setMessages(prev => {
        const idx = prev.findIndex(m => m.id === assistantMessageId);
        if (idx === -1) return prev;
        return [
          ...prev.slice(0, idx),
          { ...prev[idx], isComplete: true, content: result.response },
          ...prev.slice(idx + 1),
        ];
      });
    } catch (error) {
      setAgentStatus('idle')
      setMessages(prev => {
        const idx = prev.findIndex(m => m.id === assistantMessageId);
        if (idx === -1) return prev;
        return [
          ...prev.slice(0, idx),
          {
            ...prev[idx],
            isComplete: true,
            content: `Error: ${error}`,
            toolCalls: [...(prev[idx].toolCalls || []), {
              id: `error-${Date.now()}`,
              type: 'info',
              message: `Error: ${error}`,
            }],
          },
          ...prev.slice(idx + 1),
        ];
      });
    } finally {
      setIsSending(false)
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  return (
    <div style={styles.container}>
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.4; transform: scale(0.8); }
        }
      `}</style>
      {agentStatus !== 'idle' && (
        <div style={styles.statusBar}>
          <span style={styles.statusDot} />
          <span style={styles.statusText}>
            {agentStatus === 'thinking' && 'Thinking...'}
            {agentStatus === 'working' && 'Working...'}
            {agentStatus === 'writing' && 'Writing...'}
          </span>
        </div>
      )}
      <div style={styles.messages}>
        {messages.map(msg => (
          <div key={msg.id} style={msg.role === 'user' ? styles.userMsg : styles.assistantMsg}>
            <div style={msg.role === 'user' ? styles.userText : styles.assistantText}>
              {msg.toolCalls && msg.toolCalls.length > 0 && (
                <>
                  <div style={styles.toolCallsContainer}>
                    {msg.toolCalls.map(tc => {
                      const isExpanded = expandedIds.has(tc.id)
                      const hasDetail = tc.type === 'tool_start' && tc.input
                      const toggleExpand = () => {
                        setExpandedIds(prev => {
                          const next = new Set(prev)
                          if (next.has(tc.id)) {
                            next.delete(tc.id)
                          } else {
                            next.add(tc.id)
                          }
                          return next
                        })
                      }
                      return (
                        <div key={tc.id}>
                          <div
                            style={{
                              ...styles.toolCallRow,
                              ...(tc.type === 'tool_end' ? styles.toolCallEnd : {}),
                              ...(tc.type === 'info' ? styles.toolCallInfo : {}),
                              cursor: hasDetail ? 'pointer' : 'default',
                            }}
                            onClick={hasDetail ? toggleExpand : undefined}
                          >
                            {tc.type === 'tool_start' && '▶ '}
                            {tc.type === 'tool_end' && '✓ '}
                            {tc.type === 'info' && '• '}
                            {hasDetail && (
                              <span style={{
                                ...styles.chevron,
                                transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                              }}>▶</span>
                            )}
                            <span style={{ marginLeft: '2px' }}>{tc.message}</span>
                          </div>
                          {hasDetail && isExpanded && (
                            <div style={styles.toolDetail}>
                              {tc.input && (
                                <>
                                  <div style={styles.detailLabel}>Input:</div>
                                  <pre style={styles.detailPre}>
                                    {JSON.stringify(tc.input, null, 2)}
                                  </pre>
                                </>
                              )}
                              {tc.output && (
                                <>
                                  <div style={styles.detailLabel}>Output:</div>
                                  <pre style={styles.detailPre}>{tc.output}</pre>
                                </>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                  <div style={styles.toolCallSep} />
                </>
              )}
              <div>{msg.content}</div>
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>
      <div style={styles.inputContainer}>
        <textarea
          style={styles.input}
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder={isGatewayRunning && !isSending ? 'Type a message...' : isSending ? 'Sending...' : 'Start gateway first'}
          disabled={!isGatewayRunning || isSending}
          onKeyDown={handleKeyDown}
        />
        <button
          style={{
            ...styles.sendButton,
            ...(!isGatewayRunning || isSending ? styles.sendButtonDisabled : {})
          }}
          onClick={sendMessage}
          disabled={!isGatewayRunning || isSending}
        >
          Send
        </button>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
  },
  statusBar: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '8px 16px',
    backgroundColor: '#2a2a2a',
    borderBottom: '1px solid #333',
    fontSize: '13px',
    color: '#888',
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
  },
  statusDot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    backgroundColor: '#007AFF',
    animation: 'pulse 1.2s ease-in-out infinite',
  },
  statusText: {
    color: '#aaa',
  },
  messages: {
    flex: 1,
    padding: '16px',
    overflowY: 'auto',
  },
  userMsg: {
    display: 'flex',
    justifyContent: 'flex-end',
    marginBottom: '12px',
  },
  assistantMsg: {
    display: 'flex',
    justifyContent: 'flex-start',
    marginBottom: '12px',
  },
  userText: {
    backgroundColor: '#007AFF',
    color: '#fff',
    padding: '12px',
    borderRadius: '12px',
    maxWidth: '70%',
    whiteSpace: 'pre-wrap',
  },
  assistantText: {
    backgroundColor: '#3a3a3a',
    color: '#fff',
    padding: '12px',
    borderRadius: '12px',
    maxWidth: '70%',
    whiteSpace: 'pre-wrap',
  },
  inputContainer: {
    display: 'flex',
    padding: '12px',
    borderTop: '1px solid #333',
  },
  input: {
    flex: 1,
    backgroundColor: '#2a2a2a',
    color: '#fff',
    padding: '12px',
    borderRadius: '8px',
    minHeight: '44px',
    resize: 'none',
    border: 'none',
    outline: 'none',
    fontFamily: 'inherit',
    fontSize: '14px',
  },
  sendButton: {
    backgroundColor: '#007AFF',
    padding: '12px 20px',
    borderRadius: '8px',
    marginLeft: '8px',
    border: 'none',
    color: '#fff',
    fontWeight: '600',
    cursor: 'pointer',
  },
  sendButtonDisabled: {
    backgroundColor: '#444',
    cursor: 'not-allowed',
  },
  toolCallsContainer: {
    marginBottom: '10px',
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  toolCallRow: {
    display: 'flex',
    alignItems: 'flex-start',
    fontSize: '12px',
    color: '#6ab0f3',
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    padding: '2px 0',
    userSelect: 'text',
  },
  toolCallEnd: {
    color: '#5c5',
  },
  toolCallInfo: {
    color: '#888',
    fontStyle: 'italic',
  },
  toolCallSep: {
    borderTop: '1px solid #333',
    marginBottom: '4px',
  },
  chevron: {
    display: 'inline-block',
    fontSize: '10px',
    marginRight: '4px',
    transition: 'transform 0.15s ease',
    color: '#555',
  },
  toolDetail: {
    marginLeft: '20px',
    marginTop: '4px',
    marginBottom: '6px',
    padding: '8px',
    backgroundColor: 'rgba(0,0,0,0.3)',
    borderRadius: '6px',
    border: '1px solid #333',
  },
  detailLabel: {
    fontSize: '11px',
    color: '#666',
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    marginBottom: '4px',
    textTransform: 'uppercase',
  },
  detailPre: {
    margin: 0,
    fontSize: '11px',
    color: '#ccc',
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
}
