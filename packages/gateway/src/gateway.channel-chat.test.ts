// A channel turn must always land in a Codey chat, otherwise the Mac app has
// nothing to show and the reply exists only on the chat platform.
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChatManager } from './chats';
import { PairingStore } from './pairings';
import { Codey } from './gateway';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-chanchat-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'main'), { recursive: true });
  return root;
}

/** Minimal `this` for the method under test — it only touches these five. */
function harness() {
  const root = tmpRoot();
  const chatManager = new ChatManager(root);
  const pairingStore = new PairingStore(path.join(root, 'pairings.json'));
  const ctx = {
    chatManager,
    pairingStore,
    workspaceManager: { getCurrentWorkspace: () => 'main' },
    logger: { info: () => {}, error: () => {} },
    createChat: (input: any) => Promise.resolve(chatManager.create({ ...input, executionMode: 'shared-checkout' })),
  };
  const ensure = (Codey.prototype as any).ensureChannelChat.bind(ctx);
  const resolve = (Codey.prototype as any).resolveChatId.bind({
    ...ctx,
    isPairableChannel: (c: string) => c === 'telegram',
  });
  return { ctx, chatManager, pairingStore, ensure, resolve };
}

describe('ensureChannelChat', () => {
  it('creates a routed chat for an unpaired channel user', async () => {
    const { chatManager, ensure, resolve } = harness();
    expect(resolve('telegram', 'u1')).toBeUndefined();

    const chatId = await ensure('telegram', 'u1', 'c1');

    expect(chatId).toBeTruthy();
    expect(chatManager.get(chatId!)?.routes).toEqual([
      expect.objectContaining({ channel: 'telegram', channelUserId: 'u1', channelChatId: 'c1' }),
    ]);
    // The route is what makes the NEXT turn reuse this chat instead of piling
    // up a new one per message.
    expect(resolve('telegram', 'u1')).toBe(chatId);
  });

  it('adopts a paired user\'s workspace and marks the chat current', async () => {
    const { pairingStore, chatManager, ensure } = harness();
    const code = pairingStore.startPairing({ channel: 'telegram' });
    pairingStore.completePairing(code, { channel: 'telegram', channelUserId: 'u1', channelChatId: 'tg-1' });
    pairingStore.updatePrefs('telegram', 'u1', { workspace: 'main' });

    const chatId = await ensure('telegram', 'u1', 'ignored');

    expect(chatManager.get(chatId!)?.workspaceName).toBe('main');
    expect(chatManager.get(chatId!)?.routes?.[0].channelChatId).toBe('tg-1');
    expect(pairingStore.findByChannelUser('telegram', 'u1')?.currentChatId).toBe(chatId);
  });

  it('returns undefined instead of throwing when chat creation fails', async () => {
    const { ctx } = harness();
    const ensure = (Codey.prototype as any).ensureChannelChat.bind({
      ...ctx,
      createChat: () => Promise.reject(new Error('disk full')),
    });
    await expect(ensure('telegram', 'u1', 'c1')).resolves.toBeUndefined();
  });
});
