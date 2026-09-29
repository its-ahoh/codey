import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { BLACKBOARD_MARKER_INSTRUCTIONS } from './team-blackboard';

export interface BotPersonality {
  role: string;
  soul: string;
  instructions: string;
}

export interface BotConfig {
  /** User-facing name; routing and storage continue to use Bot.name. */
  displayName?: string;
  avatar?: { shape: 'circle' | 'square' | 'triangle' | 'capsule'; color: string };
  tools: string[];
  /**
   * Optional one-line summary fed to the auto-dispatcher when this bot
   * appears in a team with `dispatch: 'auto'`. When unset, the dispatcher
   * uses the first line of `personality.role` truncated to 120 chars.
   * `personality.soul` and `.instructions` are never sent to the dispatcher.
   */
  dispatchHint?: string;
}

export interface Bot {
  /** Stable across renames and execution backends. Assigned when a definition is loaded. */
  id?: string;
  name: string;
  personality: BotPersonality;
  config: BotConfig;
}

export interface ParallelPromptInputs {
  topic: string;
  controlPath: string;
  summaryPath: string;
  ownOpinionPath: string;
  peerOpinions: Array<{ name: string; path: string }>;
}

/** Whitelist role metadata so legacy execution settings never reach callers or disk on save. */
function roleConfig(config: BotConfig): BotConfig {
  return {
    ...(typeof config.displayName === 'string' && config.displayName.trim() ? { displayName: config.displayName.trim() } : {}),
    ...(config.avatar ? { avatar: config.avatar } : {}),
    tools: Array.isArray(config.tools) ? config.tools : [],
    ...(typeof config.dispatchHint === 'string' ? { dispatchHint: config.dispatchHint } : {}),
  };
}

export class BotManager {
  private botsDir: string;
  private bots: Map<string, Bot> = new Map();
  constructor(botsDir: string = './bots') {
    this.botsDir = botsDir;
  }

  async loadBots(): Promise<void> {
    this.bots.clear();

    if (!fs.existsSync(this.botsDir)) {
      console.log(`[Bots] Library not found at ${this.botsDir} — no bots loaded`);
      return;
    }

    const entries = fs.readdirSync(this.botsDir, { withFileTypes: true });
    const skipped: string[] = [];
    for (const entry of entries) {
      // Bots are directories with personality.md + config.json. Anything
      // else here (stray .json files from the old flat schema, leftover .DS_Store,
      // backups) is unloadable — surface it so the user can clean up rather
      // than wonder why a bot they "see on disk" doesn't appear in the UI.
      if (!entry.isDirectory()) {
        if (!entry.name.startsWith('.')) {
          console.warn(`[Bots] Ignoring non-directory entry: ${entry.name}`);
          skipped.push(entry.name);
        }
        continue;
      }
      const name = entry.name;
      const dir = path.join(this.botsDir, name);
      const contents = fs.readdirSync(dir);
      if (contents.length === 0) {
        // An empty <name>/ blocks re-creation under the same name — call it
        // out specifically so the user knows to remove the directory.
        console.warn(`[Bots] Ignoring empty directory: ${name} (delete it to free the name)`);
        skipped.push(name);
        continue;
      }
      const bot = this.loadBot(name);
      if (bot) this.bots.set(name.toLowerCase(), bot);
      else skipped.push(name);
    }

    console.log(`[Bots] Loaded ${this.bots.size} bots from ${this.botsDir}` +
      (skipped.length > 0 ? ` (skipped: ${skipped.join(', ')})` : ''));
  }

  private loadBot(name: string): Bot | null {
    const dir = path.join(this.botsDir, name);
    const mdPath = path.join(dir, 'personality.md');
    const cfgPath = path.join(dir, 'config.json');

    if (!fs.existsSync(mdPath)) {
      console.error(`[Bots] Skipping ${name}: personality.md missing`);
      return null;
    }
    if (!fs.existsSync(cfgPath)) {
      console.error(`[Bots] Skipping ${name}: config.json missing (required)`);
      return null;
    }

    let config: BotConfig;
    try {
      config = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    } catch (err) {
      console.error(`[Bots] Skipping ${name}: config.json invalid JSON (${err})`);
      return null;
    }

    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      console.error(`[Bots] Skipping ${name}: config.json must be an object`);
      return null;
    }
    config = roleConfig(config);

    let personality: BotPersonality;
    try {
      personality = this.parsePersonality(fs.readFileSync(mdPath, 'utf-8'));
    } catch (err) {
      console.error(`[Bots] Skipping ${name}: failed to read personality.md (${err})`);
      return null;
    }
    const identityPath = path.join(dir, 'identity.json');
    try {
      if (!fs.existsSync(identityPath)) {
        try { fs.writeFileSync(identityPath, JSON.stringify({ id: randomUUID() }), { flag: 'wx' }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      }
      const identity = JSON.parse(fs.readFileSync(identityPath, 'utf8')) as { id?: string };
      if (typeof identity.id !== 'string' || !/^[a-f0-9-]{36}$/.test(identity.id)) throw new Error('Invalid bot identity');
      return { id: identity.id, name, personality, config };
    } catch (error) {
      console.error(`[Bots] Skipping ${name}: cannot load durable identity (${error})`);
      return null;
    }
  }

  private parsePersonality(content: string): BotPersonality {
    const personality: BotPersonality = { role: '', soul: '', instructions: '' };
    const lines = content.split('\n');
    let currentSection = '';
    let buffer: string[] = [];

    const flush = () => {
      const trimmed = buffer.join('\n').trim();
      if (!trimmed) return;
      if (currentSection === 'role') personality.role = trimmed;
      else if (currentSection === 'soul') personality.soul = trimmed;
      else if (currentSection === 'instructions') personality.instructions = trimmed;
    };

    for (const line of lines) {
      if (line.startsWith('## ')) {
        flush();
        currentSection = line.replace(/^##\s+/, '').toLowerCase();
        buffer = [];
      } else if (line.startsWith('# ')) {
        // title line, ignored
      } else {
        buffer.push(line);
      }
    }
    flush();
    return personality;
  }

  getBot(name: string): Bot | undefined {
    return this.bots.get(name.toLowerCase());
  }

  hasBot(name: string): boolean {
    return this.bots.has(name.toLowerCase());
  }

  getAllBots(): Bot[] {
    return Array.from(this.bots.values());
  }

  getBotNames(): string[] {
    return Array.from(this.bots.keys());
  }

  /**
   * Returns the one-line summary the auto-dispatcher should see for this bot.
   * Prefers `config.dispatchHint`; otherwise falls back to the first line of
   * `personality.role` truncated to 120 characters. Empty string if the bot
   * is unknown.
   */
  getDispatchHint(name: string): string {
    const w = this.getBot(name);
    if (!w) return '';
    if (w.config.dispatchHint && w.config.dispatchHint.trim()) {
      return w.config.dispatchHint.trim();
    }
    const firstLine = (w.personality.role || '').split('\n')[0].trim();
    return firstLine.length > 120 ? firstLine.slice(0, 117) + '...' : firstLine;
  }

  buildBotPrompt(name: string, task: string): string {
    const bot = this.getBot(name);
    if (!bot) return task;
    return [
      `# Bot: ${bot.name}`,
      `## Role`,
      bot.personality.role,
      `## Personality`,
      bot.personality.soul,
      `## Instructions`,
      bot.personality.instructions,
      `## Pause for user input`,
      'If you cannot proceed without information from the user, output a single line `[ASK_USER]: <your question>` and stop. Do not guess. Do not continue the work.',
      'When the question is yes/no or a pick-one from a small set (≤ 8) of explicit options, prefer `[ASK_USER:choice]: <question> | <option 1> | <option 2>` so the user can answer with a tap. Use the free-text `[ASK_USER]:` form for open-ended questions.',
      `## Task`,
      task,
    ].join('\n\n');
  }

  /**
   * Sequential-mode variant. Includes the full team roster and (optionally) the
   * next bot in the chain so this bot can shape its output to feed into
   * the next step. Sequential mode has no Advisor arbitration, so we keep only
   * the `[ASK_USER]:` marker (no forwarding).
   */
  buildSequentialBotPrompt(
    name: string,
    task: string,
    roster: Array<{ name: string; hint: string }>,
    nextBot: { name: string; hint: string } | null,
    blackboardSection?: string,
  ): string {
    const bot = this.getBot(name);
    if (!bot) return task;
    const rosterLines = roster.length > 0
      ? roster.map(r => `- ${r.name}: ${r.hint || '(no description)'}`).join('\n')
      : '(you are the only bot on this team)';
    const nextSection = nextBot
      ? `Next up after you: **${nextBot.name}** — ${nextBot.hint || '(no description)'}.\nShape your output so it gives them what they need to do their step well: be explicit about decisions, hand off open questions clearly, and avoid burying important context in passing remarks.`
      : 'You are the last bot in this run. Aim for a complete, polished result.';
    const sections = [
      `# Bot: ${bot.name}`,
      `## Role`,
      bot.personality.role,
      `## Personality`,
      bot.personality.soul,
      `## Instructions`,
      bot.personality.instructions,
      `## Teammates (full sequence)`,
      rosterLines,
      `## Handoff`,
      nextSection,
      BLACKBOARD_MARKER_INSTRUCTIONS,
      `## Pause for user input`,
      'If you cannot proceed without information from the user, output a single line `[ASK_USER]: <your question>` and stop. Do not guess.',
      'When the question is yes/no or a pick-one from a small set (≤ 8) of explicit options, prefer `[ASK_USER:choice]: <question> | <option 1> | <option 2>` so the user can answer with a tap. Use the free-text `[ASK_USER]:` form for open-ended questions.',
    ];
    if (blackboardSection && blackboardSection.trim()) sections.push(blackboardSection);
    sections.push(`## Task`, task);
    return sections.join('\n\n');
  }

  /**
   * Auto-mode variant of buildBotPrompt. Injects the team roster (excluding self)
   * so the bot can address questions to a specific teammate via `[ASK: name]: q`,
   * falling back to `[ASK_USER]: q` when no teammate can help.
   *
   * `roster` should contain {name, hint} for every member except the running bot.
   */
  buildTeamBotPrompt(
    name: string,
    task: string,
    roster: Array<{ name: string; hint: string; lastDid?: string }>,
    blackboardSection?: string,
  ): string {
    const bot = this.getBot(name);
    if (!bot) return task;
    const rosterLines = roster.length > 0
      ? roster
          .map(r => {
            const head = `- ${r.name}: ${r.hint || '(no description)'}`;
            return r.lastDid ? `${head}\n  last did: ${r.lastDid}` : head;
          })
          .join('\n')
      : '(you are the only bot on this team)';
    const sections = [
      `# Bot: ${bot.name}`,
      `## Role`,
      bot.personality.role,
      `## Personality`,
      bot.personality.soul,
      `## Instructions`,
      bot.personality.instructions,
      `## Teammates`,
      rosterLines,
      BLACKBOARD_MARKER_INSTRUCTIONS,
      `## When you have a question`,
      [
        'If you need information you do not have:',
        '1. First check the Teammates list. If a teammate plausibly knows the answer, output a single line `[ASK: <teammate>]: <your question>` and stop. The team will route the question to that teammate directly.',
        '2. If no teammate could plausibly answer, output a single line `[ASK_USER]: <your question>` and stop. The advisor will decide whether to ask the user or route to a teammate.',
        'When the question is yes/no or a pick-one from a small set (≤ 8) of explicit options, prefer `[ASK_USER:choice]: <question> | <option 1> | <option 2>` so the user can answer with a tap. Use the free-text `[ASK_USER]:` form for open-ended questions.',
        'Use exactly one ASK marker per output. Do not guess. Do not continue the work after emitting an ASK marker.',
      ].join('\n'),
    ];
    if (blackboardSection && blackboardSection.trim()) sections.push(blackboardSection);
    sections.push(`## Task`, task);
    return sections.join('\n\n');
  }

  /**
   * Lean prompt for resuming a bot's warm CLI session via `--resume`.
   *
   * Assumes the CLI session already has the personality, roster, marker
   * protocol, ASK markers, and the previously-injected project memory in
   * its context — so we only send the delta: optional blackboard updates
   * since this session's last turn, an optional marker-protocol reminder,
   * and the new task body.
   */
  buildResumeBotPrompt(
    task: string,
    blackboardDelta?: string,
    options?: { remindMarkers?: boolean; preface?: string },
  ): string {
    const sections: string[] = [];
    if (options?.preface) sections.push(options.preface);
    if (blackboardDelta && blackboardDelta.trim()) sections.push(blackboardDelta);
    if (options?.remindMarkers) {
      sections.push('Reminder: use `[FACT]:` / `[DECISION]:` / `[HANDOFF: name]:` / `[OPEN]:` markers on their own line for structured handoffs. They are stripped from user-visible output.');
    }
    sections.push(`## Task\n${task}`);
    return sections.join('\n\n');
  }

  buildParallelBotPrompt(name: string, inputs: ParallelPromptInputs): string {
    const bot = this.getBot(name);
    if (!bot) return inputs.topic;
    const peerLines = inputs.peerOpinions.length > 0
      ? inputs.peerOpinions.map(p => `- ${p.name}'s opinion (read-only): ${p.path}`).join('\n')
      : '(no peers)';
    return [
      `# Bot: ${bot.name} (Roundtable Mode)`,
      `## Role`,
      bot.personality.role,
      `## Personality`,
      bot.personality.soul,
      `## Instructions`,
      bot.personality.instructions,
      `## Topic`,
      inputs.topic,
      `## Files (use your Read/Write tools)`,
      [
        `- Your opinion file (write): ${inputs.ownOpinionPath}`,
        `- Shared summary (read-only): ${inputs.summaryPath}`,
        `- Control file (read-only, check before EVERY write): ${inputs.controlPath}`,
        peerLines,
      ].join('\n'),
      `## Loop Protocol`,
      [
        '1. Read control.md. If status is "terminated", exit immediately. If "finalizing", write one consolidating final entry to your opinion file then exit. If "paused", wait and re-read every ~5 seconds until status changes.',
        '2. Read summary.md and each peer opinion file.',
        '3. Update YOUR opinion file (append a timestamped section; do not overwrite past entries) with your current position, what you agree/disagree with, and any open question.',
        '4. If you need information you do not have, append a single line `[ASK_ADVISOR]: <question>` at the end of your opinion file. The Advisor will route or escalate.',
        '5. If you have nothing new to add after the most recent peer/summary update, write a short "no further input" note and exit.',
        '6. Otherwise sleep briefly (the agent may simply continue) and repeat from step 1.',
      ].join('\n'),
      `## Important`,
      [
        '- Do not touch other bots\' opinion files, the summary, or control.md — those are owned by the Advisor and peers.',
        '- Keep each appended entry concise (a few short paragraphs) so peers can absorb it quickly.',
        '- Re-read control.md before every write — the Advisor may have flipped status to terminated/finalizing/paused since your last check.',
      ].join('\n'),
    ].join('\n\n');
  }

  listBots(): string {
    const all = this.getAllBots();
    if (all.length === 0) return 'No bots configured. Create folders under ./bots/<name>/ with personality.md and config.json.';
    return all.map(w => `• **${w.name}** — ${w.personality.role || '(no role)'}`).join('\n');
  }

  async saveBot(name: string, personality: BotPersonality, config: BotConfig): Promise<void> {
    const dir = path.join(this.botsDir, name);
    await fs.promises.mkdir(dir, { recursive: true });
    const personalityContent = `# Bot: ${name}\n\n## Role\n${personality.role}\n\n## Soul\n${personality.soul}\n\n## Instructions\n${personality.instructions}\n`;
    await fs.promises.writeFile(path.join(dir, 'personality.md'), personalityContent, 'utf-8');
    await fs.promises.writeFile(path.join(dir, 'config.json'), JSON.stringify(roleConfig(config), null, 2), 'utf-8');
    await this.loadBots();
  }

  async deleteBot(name: string): Promise<void> {
    const dir = path.join(this.botsDir, name);
    await fs.promises.rm(dir, { recursive: true, force: true });
    this.bots.delete(name.toLowerCase());
  }

  /**
   * Moves `<botsDir>/<oldName>` to `<botsDir>/<newName>` and rewrites the
   * personality heading. Team references are the caller's job — see
   * `renameBotInTeams`, which needs the gateway config this manager never sees.
   */
  async renameBot(oldName: string, newName: string): Promise<void> {
    if (oldName === newName) return;
    if (!BOT_NAME_RE.test(newName)) {
      throw new Error(`Bot name "${newName}" must be lowercase letters, digits and dashes, starting with a letter`);
    }
    const existing = this.bots.get(oldName.toLowerCase());
    if (!existing) throw new Error(`Bot not found: ${oldName}`);
    if (newName.toLowerCase() !== oldName.toLowerCase() && this.bots.has(newName.toLowerCase())) {
      throw new Error(`Bot "${newName}" already exists`);
    }
    const from = path.join(this.botsDir, existing.name);
    const to = path.join(this.botsDir, newName);
    await fs.promises.rename(from, to);
    const mdPath = path.join(to, 'personality.md');
    const content = await fs.promises.readFile(mdPath, 'utf-8');
    await fs.promises.writeFile(mdPath, content.replace(/^# .*(\r?\n|$)/, `# Bot: ${newName}$1`), 'utf-8');
    await this.loadBots();
  }
}

const BOT_NAME_RE = /^[a-z][a-z0-9-]*$/;

/**
 * Pure cascade for a bot rename: swaps `oldName` for `newName` in every
 * team's member list and in every flow-graph bot node. Untouched teams keep
 * their original object identity so callers can skip a config write when
 * `changed` is false.
 */
export function renameBotInTeams<T extends Record<string, any>>(
  teams: T, oldName: string, newName: string,
): { teams: T; changed: boolean } {
  const swap = (name: string) => (name === oldName ? newName : name);
  let changed = false;
  const next: Record<string, any> = {};
  for (const [teamName, raw] of Object.entries(teams)) {
    if (Array.isArray(raw)) {
      const members = raw.map(swap);
      const hit = members.some((m, i) => m !== raw[i]);
      next[teamName] = hit ? members : raw;
      changed ||= hit;
      continue;
    }
    const members: string[] = (raw.members ?? []).map(swap);
    let hit = members.some((m: string, i: number) => m !== raw.members?.[i]);
    let graph = raw.graph;
    if (graph?.nodes?.some((n: any) => n.bot === oldName)) {
      graph = { ...graph, nodes: graph.nodes.map((n: any) => (n.bot === oldName ? { ...n, bot: newName } : n)) };
      hit = true;
    }
    next[teamName] = hit ? { ...raw, members, ...(graph ? { graph } : {}) } : raw;
    changed ||= hit;
  }
  return { teams: next as T, changed };
}
