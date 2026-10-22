import { describe, it, expect, vi } from 'vitest';
import { rewriteStartPairCommand, markdownToTelegramHtml, TelegramHandler } from './telegram';

describe('rewriteStartPairCommand', () => {
  it('rewrites a QR deep-link start payload into /pair', () => {
    expect(rewriteStartPairCommand('/start pair_123456')).toBe('/pair 123456');
  });

  it('leaves a plain /start untouched', () => {
    expect(rewriteStartPairCommand('/start')).toBe('/start');
  });

  it('leaves non-pairing payloads untouched', () => {
    expect(rewriteStartPairCommand('/start something_else')).toBe('/start something_else');
    expect(rewriteStartPairCommand('/start pair_12')).toBe('/start pair_12');
    expect(rewriteStartPairCommand('/start pair_1234567')).toBe('/start pair_1234567');
  });

  it('leaves normal messages untouched', () => {
    expect(rewriteStartPairCommand('hello pair_123456')).toBe('hello pair_123456');
    expect(rewriteStartPairCommand('/pair 123456')).toBe('/pair 123456');
  });
});

describe('markdownToTelegramHtml', () => {
  it('converts bold, italic and inline code', () => {
    expect(markdownToTelegramHtml('**b** *i* `c`')).toBe('<b>b</b> <i>i</i> <code>c</code>');
  });

  it('converts bold inside list items', () => {
    expect(markdownToTelegramHtml('- **name**: value')).toBe('\u2022 <b>name</b>: value');
  });

  it('escapes html entities outside code blocks', () => {
    expect(markdownToTelegramHtml('a < b & c')).toBe('a &lt; b &amp; c');
  });

  it('wraps fenced code blocks in pre/code', () => {
    expect(markdownToTelegramHtml('```ts\nconst a = 1;\n```'))
      .toBe('<pre><code class="language-ts">const a = 1;</code></pre>');
  });
});

describe('markdownToTelegramHtml — headings, links, lists, strikethrough', () => {
  it('renders headings as bold', () => {
    expect(markdownToTelegramHtml('## Title')).toBe('<b>Title</b>');
  });

  it('keeps inline formatting inside a heading', () => {
    expect(markdownToTelegramHtml('# A **b**')).toBe('<b>A <b>b</b></b>');
  });

  it('converts links', () => {
    expect(markdownToTelegramHtml('see [docs](https://example.com/a_b)'))
      .toBe('see <a href="https://example.com/a_b">docs</a>');
  });

  it('does not let emphasis chew on a URL', () => {
    expect(markdownToTelegramHtml('[x](https://e.com/a*b*c)'))
      .toBe('<a href="https://e.com/a*b*c">x</a>');
  });

  it('normalises bullet markers', () => {
    expect(markdownToTelegramHtml('- one\n* two\n  + three'))
      .toBe('• one\n• two\n  • three');
  });

  it('converts strikethrough', () => {
    expect(markdownToTelegramHtml('~~gone~~')).toBe('<s>gone</s>');
  });

  it('leaves markdown inside code blocks alone', () => {
    expect(markdownToTelegramHtml('```\n# not a heading\n- not a bullet\n```'))
      .toBe('<pre><code># not a heading\n- not a bullet</code></pre>');
  });
});

describe('TelegramHandler.sendImages', () => {
  const att = (name: string, mimeType: string) => ({ id: name, name, path: `/w/${name}`, mimeType, size: 1 });

  it('sends raster images as photos and svg as documents, reporting failures', async () => {
    const bot = {
      sendPhoto: vi.fn(async () => ({})),
      sendDocument: vi.fn(async () => { throw new Error('too big'); }),
    };
    const h = new TelegramHandler();
    (h as any).bot = bot;
    const failed = await h.sendImages('42', [att('a.png', 'image/png'), att('b.svg', 'image/svg+xml')]);
    expect(bot.sendPhoto).toHaveBeenCalledWith('42', '/w/a.png', {}, { filename: 'a.png', contentType: 'image/png' });
    expect(bot.sendDocument).toHaveBeenCalledWith('42', '/w/b.svg', {}, { filename: 'b.svg', contentType: 'image/svg+xml' });
    expect(failed).toEqual(['b.svg']);
  });

  it('falls back to a document when sendPhoto is rejected', async () => {
    const bot = {
      sendPhoto: vi.fn(async () => { throw new Error('PHOTO_INVALID_DIMENSIONS'); }),
      sendDocument: vi.fn(async () => ({})),
    };
    const h = new TelegramHandler();
    (h as any).bot = bot;
    expect(await h.sendImages('42', [att('tall.png', 'image/png')])).toEqual([]);
    expect(bot.sendDocument).toHaveBeenCalledWith('42', '/w/tall.png', {}, { filename: 'tall.png', contentType: 'image/png' });
  });

  it('reports everything as failed when the bot is not running', async () => {
    expect(await new TelegramHandler().sendImages('42', [att('a.png', 'image/png')])).toEqual(['a.png']);
  });
});
