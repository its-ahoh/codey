// Conversation context for agents
export interface ConversationContext {
  id: string;
  userId: string;
  channel: string;
  messages: ConversationMessage[];
  lastActive: number;
  maxMessages: number;
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export class ConversationManager {
  private conversations: Map<string, ConversationContext> = new Map();
  private readonly DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes
  private readonly DEFAULT_MAX_MESSAGES = 10;

  create(userId: string, channel: string): string {
    const id = `${userId}-${channel}-${Date.now()}`;
    this.conversations.set(id, {
      id,
      userId,
      channel,
      messages: [],
      lastActive: Date.now(),
      maxMessages: this.DEFAULT_MAX_MESSAGES,
    });
    return id;
  }

  get(id: string): ConversationContext | undefined {
    const ctx = this.conversations.get(id);
    if (!ctx) return undefined;
    
    // Check if expired
    if (Date.now() - ctx.lastActive > this.DEFAULT_TTL_MS) {
      this.conversations.delete(id);
      return undefined;
    }
    
    ctx.lastActive = Date.now();
    return ctx;
  }

  getOrCreate(userId: string, channel: string, conversationId?: string): ConversationContext {
    if (conversationId) {
      const existing = this.get(conversationId);
      if (existing && existing.userId === userId && existing.channel === channel) {
        return existing;
      }
    }
    
    const id = this.create(userId, channel);
    return this.conversations.get(id)!;
  }

  addMessage(conversationId: string, role: 'user' | 'assistant', content: string): void {
    const ctx = this.conversations.get(conversationId);
    if (!ctx) return;

    ctx.messages.push({
      role,
      content,
      timestamp: Date.now(),
    });

    // Trim old messages
    if (ctx.messages.length > ctx.maxMessages) {
      ctx.messages = ctx.messages.slice(-ctx.maxMessages);
    }

    ctx.lastActive = Date.now();
  }

  getHistory(conversationId: string): ConversationMessage[] {
    const ctx = this.conversations.get(conversationId);
    return ctx?.messages || [];
  }

  buildPrompt(conversationId: string, currentPrompt: string): string {
    const history = this.getHistory(conversationId);
    if (history.length === 0) return currentPrompt;

    const context = history
      .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n\n');

    return `Previous conversation:\n${context}\n\nCurrent request:\n${currentPrompt}`;
  }

  clear(conversationId: string): void {
    this.conversations.delete(conversationId);
  }

  // Cleanup expired conversations
  cleanup(): number {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [id, ctx] of this.conversations) {
      if (now - ctx.lastActive > this.DEFAULT_TTL_MS) {
        this.conversations.delete(id);
        cleaned++;
      }
    }
    
    return cleaned;
  }
}
