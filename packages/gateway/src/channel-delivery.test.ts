import { describe, it, expect, vi } from 'vitest';
import type { FileAttachment } from '@codey/core';
import { channelMessageLimit, deliverMediaExtras } from './channel-delivery';

const img = (name: string): FileAttachment => ({ id: name, name, path: `/w/.codey/uploads/outputs/${name}`, mimeType: 'image/png', size: 1 });

describe('channelMessageLimit', () => {
  it('uses each platform limit', () => {
    expect(channelMessageLimit('telegram')).toBe(4096);
    expect(channelMessageLimit('discord')).toBe(2000);
    expect(channelMessageLimit('imessage')).toBe(2000);
  });
});

describe('deliverMediaExtras', () => {
  it('sends images, then one preview link per mermaid block', async () => {
    const calls: string[] = [];
    await deliverMediaExtras({
      originalText: 'x\n```mermaid\ngraph TD\nA-->B\n```',
      attachments: [img('a.png')],
      maxLinkLength: 4096,
      sendText: async t => { calls.push(`text:${t.slice(0, 31)}`); },
      sendImages: async imgs => { calls.push(`images:${imgs.map(i => i.name).join(',')}`); return []; },
    });
    expect(calls).toEqual(['images:a.png', 'text:Diagram preview: https://mermai']);
  });

  it('reports failed images without throwing', async () => {
    const sendText = vi.fn(async () => {});
    await deliverMediaExtras({
      originalText: '',
      attachments: [img('a.png'), img('b.png')],
      maxLinkLength: 4096,
      sendText,
      sendImages: async () => ['b.png'],
    });
    expect(sendText).toHaveBeenCalledWith('Image failed to send: b.png');
  });

  it('treats a throwing sender and a missing sender as all failed', async () => {
    const sendText = vi.fn(async (_text: string) => {});
    await deliverMediaExtras({
      originalText: '', attachments: [img('a.png')], maxLinkLength: 4096, sendText,
      sendImages: async () => { throw new Error('boom'); },
    });
    await deliverMediaExtras({ originalText: '', attachments: [img('c.png')], maxLinkLength: 4096, sendText });
    expect(sendText.mock.calls.map(c => c[0])).toEqual(['Image failed to send: a.png', 'Image failed to send: c.png']);
  });

  it('survives a sendText that throws synchronously', async () => {
    const log = vi.fn();
    const sendText = vi.fn((_text: string): Promise<void> => { throw new Error('sync boom'); });
    await expect(deliverMediaExtras({
      originalText: '```mermaid\ngraph TD\nA-->B\n```',
      attachments: [img('a.png')],
      maxLinkLength: 4096,
      sendText,
      sendImages: async () => ['a.png'],
      log,
    })).resolves.toBeUndefined();
    expect(sendText).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('skips a preview link longer than the channel limit', async () => {
    const sendText = vi.fn(async () => {});
    await deliverMediaExtras({
      originalText: '```mermaid\ngraph TD\nA-->B\n```', attachments: [], maxLinkLength: 20, sendText,
    });
    expect(sendText).not.toHaveBeenCalled();
  });

  it('does nothing for plain text', async () => {
    const sendText = vi.fn(async () => {});
    await deliverMediaExtras({ originalText: 'hello', attachments: [], maxLinkLength: 4096, sendText });
    expect(sendText).not.toHaveBeenCalled();
  });
});
