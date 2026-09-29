import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BotManager, renameBotInTeams } from './bots';

function seedBots(botsDir: string, names: string[]) {
  for (const n of names) {
    fs.mkdirSync(path.join(botsDir, n), { recursive: true });
    fs.writeFileSync(
      path.join(botsDir, n, 'personality.md'),
      `# ${n}\n## Role\nROLE_OF_${n}\n## Soul\n.\n## Instructions\n.\n`,
    );
    fs.writeFileSync(
      path.join(botsDir, n, 'config.json'),
      JSON.stringify({ codingAgent: 'claude-code', model: 'm', tools: [] }),
    );
  }
}

describe('BotManager.buildParallelBotPrompt', () => {
  it('builds a parallel-mode prompt with role, topic, file paths, ASK_ADVISOR, and control protocol', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bots-parallel-'));
    seedBots(root, ['alice', 'bob']);
    const wm = new BotManager(root);
    await wm.loadBots();

    const prompt = wm.buildParallelBotPrompt('alice', {
      topic: 'Pick a database',
      controlPath: '/tmp/c.md',
      summaryPath: '/tmp/s.md',
      ownOpinionPath: '/tmp/alice.md',
      peerOpinions: [{ name: 'bob', path: '/tmp/bob.md' }],
    });

    expect(prompt).toContain('ROLE_OF_alice');
    expect(prompt).toContain('Pick a database');
    expect(prompt).toContain('/tmp/alice.md');
    expect(prompt).toContain('/tmp/s.md');
    expect(prompt).toContain('/tmp/c.md');
    expect(prompt).toContain('/tmp/bob.md');
    expect(prompt).toContain('[ASK_ADVISOR]');
    expect(prompt.toLowerCase()).toContain('read control.md');
  });

  it('returns the topic unchanged for an unknown bot', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bots-parallel-'));
    seedBots(root, ['alice']);
    const wm = new BotManager(root);
    await wm.loadBots();

    const prompt = wm.buildParallelBotPrompt('nobody', {
      topic: 'just-the-topic',
      controlPath: 'c',
      summaryPath: 's',
      ownOpinionPath: 'o',
      peerOpinions: [],
    });
    expect(prompt).toBe('just-the-topic');
  });
});

describe('bot avatar persistence', () => {
  it('loads old members and round-trips independent shape and color choices', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-avatar-'));
    try {
      seedBots(root, ['alice']);
      const manager = new BotManager(root);
      await manager.loadBots();
      const bot = manager.getBot('alice')!;
      expect(bot.config.avatar).toBeUndefined();
      await manager.saveBot('alice', bot.personality, {
        ...bot.config, avatar: { shape: 'triangle', color: '#8CCDB5' },
      });
      const reloaded = new BotManager(root);
      await reloaded.loadBots();
      expect(reloaded.getBot('alice')!.config.avatar).toEqual({ shape: 'triangle', color: '#8CCDB5' });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('BotManager.renameBot', () => {
  it('moves the folder, rewrites the personality heading, and reloads under the new name', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-rename-'));
    try {
      seedBots(root, ['alice', 'bob']);
      const manager = new BotManager(root);
      await manager.loadBots();
      const originalId = manager.getBot('alice')!.id;
      await manager.renameBot('alice', 'alicia');
      expect(manager.getBot('alicia')!.id).toBe(originalId);
      expect(originalId).toBeTruthy();

      expect(fs.existsSync(path.join(root, 'alice'))).toBe(false);
      expect(fs.readFileSync(path.join(root, 'alicia', 'personality.md'), 'utf-8')).toMatch(/^# Bot: alicia\n/);
      expect(manager.getBot('alice')).toBeUndefined();
      expect(manager.getBot('alicia')!.personality.role).toBe('ROLE_OF_alice');
      expect(manager.getBot('bob')).toBeDefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects invalid, missing, and already-taken names without touching disk', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-rename-'));
    try {
      seedBots(root, ['alice', 'bob']);
      const manager = new BotManager(root);
      await manager.loadBots();
      await expect(manager.renameBot('alice', 'Bad Name')).rejects.toThrow(/lowercase/);
      await expect(manager.renameBot('ghost', 'x')).rejects.toThrow(/not found/i);
      await expect(manager.renameBot('alice', 'bob')).rejects.toThrow(/already exists/i);
      expect(fs.existsSync(path.join(root, 'alice'))).toBe(true);
      expect(manager.getBot('alice')).toBeDefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('is a no-op when the name does not change', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-rename-'));
    try {
      seedBots(root, ['alice']);
      const manager = new BotManager(root);
      await manager.loadBots();
      await manager.renameBot('alice', 'alice');
      expect(manager.getBot('alice')).toBeDefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('renameBotInTeams', () => {
  it('rewrites members and graph bot nodes in every team that references the bot', () => {
    const teams = {
      legacy: ['alice', 'bob'],
      flow: {
        members: ['alice'],
        dispatch: 'sequential' as const,
        graph: {
          entry: 'start', maxHops: 5,
          nodes: [
            { id: 'start', type: 'start' as const, x: 0, y: 0 },
            { id: 'n1', type: 'bot' as const, bot: 'alice', x: 0, y: 0 },
            { id: 'end', type: 'end' as const, x: 0, y: 0 },
          ],
          edges: [{ id: 'e1', from: 'start', to: 'n1' }, { id: 'e2', from: 'n1', to: 'end' }],
        },
      },
      untouched: ['bob'],
    };
    const { teams: next, changed } = renameBotInTeams(teams, 'alice', 'alicia');
    expect(changed).toBe(true);
    expect(next.legacy).toEqual(['alicia', 'bob']);
    expect((next.flow as any).members).toEqual(['alicia']);
    expect((next.flow as any).graph.nodes[1].bot).toBe('alicia');
    expect((next.flow as any).graph.edges).toEqual(teams.flow.graph.edges);
    expect(next.untouched).toBe(teams.untouched);
    expect(teams.legacy).toEqual(['alice', 'bob']);
  });

  it('reports no change when nothing references the bot', () => {
    const teams = { a: ['bob'] };
    const result = renameBotInTeams(teams, 'alice', 'alicia');
    expect(result.changed).toBe(false);
    expect(result.teams).toEqual(teams);
  });
});


describe('role-only bot configuration', () => {
  it('ignores legacy execution bindings and strips them on save while keeping role metadata', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-role-only-'));
    try {
      seedBots(root, ['alice']);
      const configPath = path.join(root, 'alice', 'config.json');
      const legacy = { codingAgent: 'retired-agent', model: 'retired-model', effort: 'high', tools: ['git'], dispatchHint: 'Reviews changes' };
      fs.writeFileSync(configPath, JSON.stringify(legacy));
      const manager = new BotManager(root);
      await manager.loadBots();
      const bot = manager.getBot('alice')!;
      expect(bot.config).toEqual({ tools: ['git'], dispatchHint: 'Reviews changes' });
      expect(manager.listBots()).not.toContain('retired-model');
      await manager.saveBot('alice', bot.personality, legacy);
      expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toEqual(bot.config);
      expect(manager.getBot('alice')!.personality).toEqual(bot.personality);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});


describe('bot display names', () => {
  it('persists a display name without changing identity, directory, or lookup', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-display-name-'));
    try {
      seedBots(root, ['alice']);
      const manager = new BotManager(root);
      await manager.loadBots();
      const bot = manager.getBot('alice')!;
      expect(bot.config.displayName).toBeUndefined();
      for (const displayName of ['Alice Smith', '\u5c0f\u52a9\u624b']) {
        await manager.saveBot('alice', bot.personality, { ...bot.config, displayName: ` ${displayName} ` });
        const reloaded = new BotManager(root);
        await reloaded.loadBots();
        expect(reloaded.getBot('ALICE')).toMatchObject({ id: bot.id, name: 'alice', config: { displayName } });
        expect(reloaded.getAllBots()).toHaveLength(1);
        expect(fs.existsSync(path.join(root, 'alice', 'config.json'))).toBe(true);
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
