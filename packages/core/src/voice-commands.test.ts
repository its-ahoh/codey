import { describe, it, expect } from 'vitest';
import { parseVoiceCommand } from './voice-commands';

describe('parseVoiceCommand', () => {
  it('matches workspace switch phrasing variants', () => {
    expect(parseVoiceCommand('switch to workspace codey')).toEqual({
      type: 'switch-workspace',
      workspace: 'codey',
    });
    expect(parseVoiceCommand('go to the workspace my project')).toEqual({
      type: 'switch-workspace',
      workspace: 'my project',
    });
    expect(parseVoiceCommand('change workspace notes.')).toEqual({
      type: 'switch-workspace',
      workspace: 'notes',
    });
  });

  it('matches notification queries', () => {
    expect(parseVoiceCommand("what's my notifications")).toEqual({ type: 'list-notifications' });
    expect(parseVoiceCommand('check my notifications?')).toEqual({ type: 'list-notifications' });
  });

  it('matches workspace listing', () => {
    expect(parseVoiceCommand('list workspaces')).toEqual({ type: 'list-workspaces' });
  });

  it('is case-insensitive', () => {
    expect(parseVoiceCommand('SWITCH TO WORKSPACE Codey')).toEqual({
      type: 'switch-workspace',
      workspace: 'Codey',
    });
  });

  it('returns null for ordinary conversation', () => {
    expect(parseVoiceCommand('can you fix the bug in workspace.ts')).toBeNull();
    expect(parseVoiceCommand('what does this function do')).toBeNull();
    expect(parseVoiceCommand('')).toBeNull();
  });

  it('matches Chinese workspace switch phrasing variants', () => {
    expect(parseVoiceCommand('切换到工作区codey')).toEqual({
      type: 'switch-workspace',
      workspace: 'codey',
    });
    expect(parseVoiceCommand('切到工作空间笔记')).toEqual({
      type: 'switch-workspace',
      workspace: '笔记',
    });
    expect(parseVoiceCommand('跳转到工作区 codey 。')).toEqual({
      type: 'switch-workspace',
      workspace: 'codey',
    });
  });

  it('matches Chinese name-first and mixed Chinese/English variants', () => {
    expect(parseVoiceCommand('切换到codey工作区')).toEqual({
      type: 'switch-workspace',
      workspace: 'codey',
    });
    expect(parseVoiceCommand('切换到笔记工作空间')).toEqual({
      type: 'switch-workspace',
      workspace: '笔记',
    });
    expect(parseVoiceCommand('切换到 workspace codey')).toEqual({
      type: 'switch-workspace',
      workspace: 'codey',
    });
    expect(parseVoiceCommand('切换到 codey workspace')).toEqual({
      type: 'switch-workspace',
      workspace: 'codey',
    });
  });

  it('matches Chinese notification queries', () => {
    expect(parseVoiceCommand('查看我的通知')).toEqual({ type: 'list-notifications' });
    expect(parseVoiceCommand('通知')).toEqual({ type: 'list-notifications' });
    expect(parseVoiceCommand('我的通知有哪些')).toEqual({ type: 'list-notifications' });
  });

  it('matches Chinese workspace listing', () => {
    expect(parseVoiceCommand('列出我的工作区')).toEqual({ type: 'list-workspaces' });
    expect(parseVoiceCommand('显示所有工作空间列表')).toEqual({ type: 'list-workspaces' });
  });

  it('returns null for ordinary Chinese conversation', () => {
    expect(parseVoiceCommand('帮我修复这个工作区里的bug')).toBeNull();
    expect(parseVoiceCommand('这个函数是做什么的')).toBeNull();
  });
});

describe('parseVoiceCommand — more detail', () => {
  it('matches English phrasings', () => {
    for (const phrase of [
      'more detail',
      'more details',
      'in more detail',
      'tell me more',
      'say more',
      'elaborate',
      'expand on that',
      'More Detail.',
    ]) {
      expect(parseVoiceCommand(phrase), phrase).toEqual({ type: 'more-detail' });
    }
  });

  it('matches Chinese phrasings', () => {
    for (const phrase of [
      '说详细点',
      '详细点',
      '再详细一点',
      '说得更详细',
      '详细说说',
      '更详细一些',
      '展开讲讲',
      '多说一点',
      '说详细点。',
    ]) {
      expect(parseVoiceCommand(phrase), phrase).toEqual({ type: 'more-detail' });
    }
  });

  it('does not swallow ordinary speech that merely mentions detail', () => {
    for (const phrase of [
      '把这个函数写得更详细一点的注释',
      'add more detail to the readme',
      '详细看看这个 bug',
      'what are the details of the plan',
    ]) {
      expect(parseVoiceCommand(phrase), phrase).toBeNull();
    }
  });
});
