export type Surface = 'mac' | 'telegram' | 'discord' | 'imessage';

export interface QueuedMessage {
  surface: Surface;
  text: string;
  userId: string;
  timestamp: number;
}

export type TurnRunner = (chatId: string, batch: QueuedMessage[]) => Promise<unknown>;

interface ChatState {
  running: boolean;
  pending: QueuedMessage[];
  active?: Promise<void>;
}

export class TurnQueue {
  private states = new Map<string, ChatState>();

  constructor(private readonly runner: TurnRunner) {}

  submit(chatId: string, msg: QueuedMessage): void {
    const s = this.states.get(chatId) ?? { running: false, pending: [] };
    this.states.set(chatId, s);
    s.pending.push(msg);
    if (!s.running) this.kick(chatId);
  }

  private kick(chatId: string): void {
    const s = this.states.get(chatId);
    if (!s || s.running || s.pending.length === 0) return;
    s.running = true;
    const batch = s.pending.splice(0, s.pending.length);
    s.active = (async () => {
      try {
        await this.runner(chatId, batch);
      } finally {
        s.running = false;
        if (s.pending.length > 0) {
          this.kick(chatId);
        } else {
          this.states.delete(chatId);
        }
      }
    })();
  }

  async drain(): Promise<void> {
    while (true) {
      const promises = [...this.states.values()].map(s => s.active).filter(Boolean) as Promise<void>[];
      if (promises.length === 0) return;
      await Promise.all(promises);
    }
  }
}
