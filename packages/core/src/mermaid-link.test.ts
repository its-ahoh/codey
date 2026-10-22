import { describe, it, expect } from 'vitest';
import { inflateSync } from 'zlib';
import { findMermaidBlocks, mermaidLiveUrl } from './mermaid-link';

describe('findMermaidBlocks', () => {
  it('returns the source of each mermaid fence and skips other fences', () => {
    const text = 'a\n```mermaid\ngraph TD\n  A-->B\n```\n```ts\nx\n```\n```mermaid\nsequenceDiagram\n```';
    expect(findMermaidBlocks(text)).toEqual(['graph TD\n  A-->B', 'sequenceDiagram']);
  });

  it('ignores an unterminated fence', () => {
    expect(findMermaidBlocks('```mermaid\ngraph TD')).toEqual([]);
  });
});

describe('mermaidLiveUrl', () => {
  it('encodes the diagram as a pako fragment that round-trips', () => {
    const url = mermaidLiveUrl('graph TD\n  A-->B');
    expect(url.startsWith('https://mermaid.live/view#pako:')).toBe(true);
    const data = url.split('#pako:')[1];
    expect(data).toMatch(/^[A-Za-z0-9_-]+$/);
    const state = JSON.parse(inflateSync(Buffer.from(data, 'base64url')).toString('utf8'));
    expect(state.code).toBe('graph TD\n  A-->B');
    expect(JSON.parse(state.mermaid)).toEqual({ theme: 'default' });
  });
});
