import { findMermaidBlocks, mermaidLiveUrl, type FileAttachment, type ChannelType } from '@codey/core';

export function channelMessageLimit(channel: ChannelType | string): number {
  return channel === 'telegram' ? 4096 : 2000;
}

export interface MediaExtrasArgs {
  /** The reply as the agent wrote it (mermaid fences intact). */
  originalText: string;
  attachments: FileAttachment[];
  maxLinkLength: number;
  sendText: (text: string) => Promise<void>;
  /** Returns the names of images that failed. Absent = channel cannot send files. */
  sendImages?: (images: FileAttachment[]) => Promise<string[]>;
  log?: (message: string) => void;
}

/**
 * Everything a channel receives after the reply text: the image files, a
 * failure note when some did not go out, and one mermaid.live link per
 * mermaid block. Each link is its own message so chunking can never split it.
 * Never throws: the reply text has already been delivered.
 */
export async function deliverMediaExtras(args: MediaExtrasArgs): Promise<void> {
  const { attachments, sendText, sendImages, log } = args;
  if (attachments.length > 0) {
    let failed: string[];
    try {
      failed = sendImages ? await sendImages(attachments) : attachments.map(a => a.name);
    } catch (err) {
      log?.(`[media] image send failed: ${(err as Error).message}`);
      failed = attachments.map(a => a.name);
    }
    if (failed.length > 0) {
      try {
        await sendText(`Image failed to send: ${failed.join(', ')}`);
      } catch (err) {
        log?.(`[media] failure note failed: ${(err as Error).message}`);
      }
    }
  }
  for (const code of findMermaidBlocks(args.originalText)) {
    const line = `Diagram preview: ${mermaidLiveUrl(code)}`;
    if (line.length > args.maxLinkLength) {
      log?.(`[media] mermaid preview link skipped (${line.length} chars)`);
      continue;
    }
    try {
      await sendText(line);
    } catch (err) {
      log?.(`[media] preview link failed: ${(err as Error).message}`);
    }
  }
}
