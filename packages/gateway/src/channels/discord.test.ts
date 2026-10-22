import { describe, it, expect, vi } from 'vitest';
import { TextChannel } from 'discord.js';
import { DiscordHandler } from './discord';

const att = (name: string) => ({ id: name, name, path: `/w/${name}`, mimeType: 'image/png', size: 1 });

const handlerWith = (send: (arg: unknown) => Promise<unknown>) => {
  const channel = Object.create(TextChannel.prototype);
  channel.send = vi.fn(send);
  const h = new DiscordHandler();
  (h as any).client = { channels: { fetch: vi.fn(async () => channel) } };
  return { h, channel };
};

describe('DiscordHandler.sendImages', () => {
  it('sends every image in one message', async () => {
    const { h, channel } = handlerWith(async () => ({}));
    expect(await h.sendImages('c1', [att('a.png'), att('b.png')])).toEqual([]);
    expect(channel.send).toHaveBeenCalledWith({
      files: [{ attachment: '/w/a.png', name: 'a.png' }, { attachment: '/w/b.png', name: 'b.png' }],
    });
  });

  it('reports all images when the send fails', async () => {
    const { h } = handlerWith(async () => { throw new Error('413'); });
    expect(await h.sendImages('c1', [att('a.png')])).toEqual(['a.png']);
  });

  it('reports all images when the client is not running', async () => {
    expect(await new DiscordHandler().sendImages('c1', [att('a.png')])).toEqual(['a.png']);
  });
});
