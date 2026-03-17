import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { ChatMessage } from '../types';
import { apiService } from '../services/api';

interface ChatTabProps {
  isGatewayRunning: boolean;
}

export const ChatTab: React.FC<ChatTabProps> = ({ isGatewayRunning }) => {
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const sendMessage = async () => {
    if (!input.trim() || !isGatewayRunning) return;

    const userMessage: ChatMessage = {
      id: Date.now().toString(),
      role: 'user',
      content: input,
      timestamp: Date.now(),
    };

    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);

    try {
      const response = await apiService.sendMessage(input);
      const assistantMessage: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: response,
        timestamp: Date.now(),
      };
      setMessages(prev => [...prev, assistantMessage]);
    } catch (error) {
      const errorMessage: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: `Error: ${error}`,
        timestamp: Date.now(),
      };
      setMessages(prev => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      <ScrollView style={styles.messages}>
        {messages.map(msg => (
          <View key={msg.id} style={msg.role === 'user' ? styles.userMsg : styles.assistantMsg}>
            <Text style={msg.role === 'user' ? styles.userText : styles.assistantText}>
              {msg.content}
            </Text>
          </View>
        ))}
        {isLoading && <Text style={styles.loading}>Thinking...</Text>}
      </ScrollView>
      <View style={styles.inputContainer}>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder={isGatewayRunning ? 'Type a message...' : 'Start gateway first'}
          placeholderTextColor="#888"
          multiline
          editable={isGatewayRunning}
        />
        <TouchableOpacity
          style={[styles.sendButton, !isGatewayRunning && styles.sendButtonDisabled]}
          onPress={sendMessage}
          disabled={!isGatewayRunning}
        >
          <Text style={styles.sendButtonText}>Send</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  messages: { flex: 1, padding: 16 },
  userMsg: { alignItems: 'flex-end', marginBottom: 12 },
  assistantMsg: { alignItems: 'flex-start', marginBottom: 12 },
  userText: { backgroundColor: '#007AFF', color: '#fff', padding: 12, borderRadius: 12 },
  assistantText: { backgroundColor: '#3a3a3a', color: '#fff', padding: 12, borderRadius: 12 },
  loading: { color: '#888', fontStyle: 'italic' },
  inputContainer: { flexDirection: 'row', padding: 12, borderTopWidth: 1, borderTopColor: '#333' },
  input: { flex: 1, backgroundColor: '#2a2a2a', color: '#fff', padding: 12, borderRadius: 8, minHeight: 44 },
  sendButton: { backgroundColor: '#007AFF', padding: 12, borderRadius: 8, marginLeft: 8 },
  sendButtonDisabled: { backgroundColor: '#444' },
  sendButtonText: { color: '#fff', fontWeight: '600' },
});
