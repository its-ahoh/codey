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
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages])

  const sendMessage = async () => {
    if (!input.trim() || !isGatewayRunning) return;

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

    try {
      const response = await apiService.sendMessage(
        input,
        (update) => {
          // update: { type, tool?, message }
          setMessages(prev => {
            const idx = prev.findIndex(m => m.id === assistantMessageId);
            if (idx === -1) return prev;
            const entry: ToolCallEntry = {
              id: `tool-${Date.now()}-${Math.random()}`,
              type: update.type as 'tool_start' | 'tool_end' | 'info',
              tool: update.tool,
              message: update.message,
            };
            return [
              ...prev.slice(0, idx),
              { ...prev[idx], toolCalls: [...(prev[idx].toolCalls || []), entry] },
              ...prev.slice(idx + 1),
            ];
          });
        },
        (text) => {
          // Append streamed text to the assistant message
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
      );

      // Mark complete
      setMessages(prev => {
        const idx = prev.findIndex(m => m.id === assistantMessageId);
        if (idx === -1) return prev;
        return [
          ...prev.slice(0, idx),
          { ...prev[idx], isComplete: true, content: response },
          ...prev.slice(idx + 1),
        ];
      });
    } catch (error) {
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
      <div style={styles.messages}>
        {messages.map(msg => (
          <div key={msg.id} style={msg.role === 'user' ? styles.userMsg : styles.assistantMsg}>
            <div style={msg.role === 'user' ? styles.userText : styles.assistantText}>
              {msg.toolCalls && msg.toolCalls.length > 0 && (
                <>
                  <div style={styles.toolCallsContainer}>
                    {msg.toolCalls.map(tc => (
                      <div
                        key={tc.id}
                        style={{
                          ...styles.toolCall,
                          ...(tc.type === 'tool_end' ? styles.toolCallEnd : {}),
                          ...(tc.type === 'info' ? styles.toolCallInfo : {}),
                        }}
                      >
                        {tc.type === 'tool_start' && '▶ '}
                        {tc.type === 'tool_end' && '✓ '}
                        {tc.message}
                      </div>
                    ))}
                  </div>
                  <div style={styles.toolCallSep} />
                </>
              )}
              <div>{msg.content}</div>
            </div>
          </div>
        ))}
        {!messages[messages.length - 1]?.isComplete && messages[messages.length - 1]?.role === 'assistant' && (
          <div style={styles.loading}>
            ▶ {(() => {
              const last = messages[messages.length - 1]
              const toolCalls = last?.toolCalls
              return toolCalls?.length
                ? toolCalls[toolCalls.length - 1]?.message
                : 'Thinking...'
            })()}
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>
      <div style={styles.inputContainer}>
        <textarea
          style={styles.input}
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder={isGatewayRunning ? 'Type a message...' : 'Start gateway first'}
          disabled={!isGatewayRunning}
          onKeyDown={handleKeyDown}
        />
        <button
          style={{
            ...styles.sendButton,
            ...(!isGatewayRunning ? styles.sendButtonDisabled : {})
          }}
          onClick={sendMessage}
          disabled={!isGatewayRunning}
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
  loading: {
    color: '#888',
    fontSize: '12px',
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    padding: '4px 0',
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
    gap: '4px',
  },
  toolCall: {
    fontSize: '12px',
    color: '#6ab0f3',
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    padding: '3px 0',
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
}
