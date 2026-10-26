import { describe, it, expect, vi } from 'vitest';
import { TextChannel } from 'discord.js';
import { DiscordHandler } from './discord';

const att = (name: string, size = 1) => ({ id: name, name, path: `/w/${name}`, mimeType: 'image/png', size });
const MiB = 1024 * 1024;
const sentNames = (call: unknown[]) => (call[0] as { files: { name: string }[] }).files.map(f => f.name);

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

  it('splits more than 10 images into batches of at most 10', async () => {
    const { h, channel } = handlerWith(async () => ({}));
    const imgs = Array.from({ length: 12 }, (_, i) => att(`i${i}.png`));
    expect(await h.sendImages('c1', imgs)).toEqual([]);
    expect(channel.send).toHaveBeenCalledTimes(2);
    expect(sentNames(channel.send.mock.calls[0])).toHaveLength(10);
    expect(sentNames(channel.send.mock.calls[1])).toEqual(['i10.png', 'i11.png']);
  });

  it('splits batches so their total size stays within 8 MiB', async () => {
    const { h, channel } = handlerWith(async () => ({}));
    const imgs = [att('a.png', 3 * MiB), att('b.png', 4 * MiB), att('c.png', 2 * MiB), att('big.png', 9 * MiB), att('d.png', 1)];
    expect(await h.sendImages('c1', imgs)).toEqual([]);
    expect(channel.send.mock.calls.map(sentNames)).toEqual([['a.png', 'b.png'], ['c.png'], ['big.png'], ['d.png']]);
  });

  it('retries a failed batch one file at a time and reports only individual failures', async () => {
    const { h, channel } = handlerWith(async (arg) => {
      const names = (arg as { files: { name: string }[] }).files.map(f => f.name);
      if (names.length > 1 || names[0] === 'bad.png') throw new Error('413');
      return {};
    });
    expect(await h.sendImages('c1', [att('ok.png'), att('bad.png')])).toEqual(['bad.png']);
    expect(channel.send).toHaveBeenCalledTimes(3);
  });

  it('reports all images when the client is not running', async () => {
    expect(await new DiscordHandler().sendImages('c1', [att('a.png')])).toEqual(['a.png']);
  });
});
