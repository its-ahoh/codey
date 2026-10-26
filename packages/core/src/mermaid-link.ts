import { deflateSync } from 'zlib';

const MERMAID_FENCE_RE = /^```mermaid[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm;

/** Sources of every complete ```mermaid fence, in order. */
export function findMermaidBlocks(text: string): string[] {
  return [...text.matchAll(MERMAID_FENCE_RE)].map(m => m[1]);
}

/**
 * mermaid.live "pako" link. The diagram lives in the URL fragment, which the
 * browser never sends to the server.
 */
export function mermaidLiveUrl(code: string): string {
  const state = JSON.stringify({ code, mermaid: JSON.stringify({ theme: 'default' }) });
  const data = deflateSync(Buffer.from(state, 'utf8'), { level: 9 }).toString('base64url');
  return `https://mermaid.live/view#pako:${data}`;
}
