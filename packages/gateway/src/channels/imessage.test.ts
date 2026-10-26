import { describe, it, expect, vi } from 'vitest';

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('child_process', async (orig) => ({ ...(await orig<typeof import('child_process')>()), execFile }));

import { IMessageHandler, buildSendFileScript } from './imessage';

describe('buildSendFileScript', () => {
  it('quotes paths and recipients for AppleScript', () => {
    expect(buildSendFileScript('a@b.c', '/w/my "chart".png'))
      .toBe('tell application "Messages" to send (POSIX file "/w/my \\"chart\\".png") to buddy "a@b.c"');
  });
});

describe('IMessageHandler.sendImages', () => {
  it('sends one file per image with execFile and reports failures', async () => {
    execFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: (e: Error | null) => void) => {
      cb(args[1].includes('bad.png') ? new Error('denied') : null);
    });
    const h = new IMessageHandler();
    const failed = await h.sendImages('+1555', [
      { id: '1', name: 'ok.png', path: '/w/ok.png', mimeType: 'image/png', size: 1 },
      { id: '2', name: 'bad.png', path: '/w/bad.png', mimeType: 'image/png', size: 1 },
    ]);
    expect(execFile).toHaveBeenCalledTimes(2);
    expect(execFile.mock.calls[0][0]).toBe('osascript');
    expect(execFile.mock.calls[0][1][0]).toBe('-e');
    expect(execFile.mock.calls[0][2]).toEqual({ timeout: 30_000 });
    expect(failed).toEqual(['bad.png']);
  });
});
