import React, { useState, useRef, useEffect } from 'react'
import { ChatMessage } from '../types'
import { apiService } from '../services/api'

interface ChatTabProps {
  isGatewayRunning: boolean
  messages: ChatMessage[]
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>
  isLoading: boolean
  setIsLoading: React.Dispatch<React.SetStateAction<boolean>>
}

export const ChatTab: React.FC<ChatTabProps> = ({ isGatewayRunning, messages, setMessages, isLoading, setIsLoading }) => {
  const [input, setInput] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages])

  const sendMessage = async () => {
    if (!input.trim() || !isGatewayRunning) return

    const userMessage: ChatMessage = {
      id: Date.now().toString(),
      role: 'user',
      content: input,
      timestamp: Date.now(),
    }

    setMessages(prev => [...prev, userMessage])
    setInput('')
    setIsLoading(true)

    try {
      const response = await apiService.sendMessage(input)
      const assistantMessage: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: response,
        timestamp: Date.now(),
      }
      setMessages(prev => [...prev, assistantMessage])
    } catch (error) {
      const errorMessage: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: `Error: ${error}`,
        timestamp: Date.now(),
      }
      setMessages(prev => [...prev, errorMessage])
    } finally {
      setIsLoading(false)
    }
  }

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
              {msg.content}
            </div>
          </div>
        ))}
        {isLoading && <div style={styles.loading}>Thinking...</div>}
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
    fontStyle: 'italic',
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
}
