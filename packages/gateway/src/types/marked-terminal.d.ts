declare module 'marked-terminal' {
  import { MarkedExtension } from 'marked';
  export function markedTerminal(options?: Record<string, unknown>): MarkedExtension;
}
