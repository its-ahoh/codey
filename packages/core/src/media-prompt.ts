/**
 * Appended to every turn's prompt (sessions are resumed, so a chat linked to a
 * channel mid-session must see the PNG rule on its next turn).
 */
export function mediaOutputInstruction(channelLinked: boolean): string {
  const base = '\n\n[Codey media output]\nTo show an image to the user, save it as a file inside the working directory (or the system temp directory) and reference it in your reply with Markdown: ![short description](path/to/file.png). Supported: png, jpg, gif, webp, svg, up to 10 MB.';
  return channelLinked
    ? `${base}\nThis chat is delivered to a messaging app (Telegram, Discord or iMessage). Draw charts and diagrams as PNG image files and reference them as above; do not use mermaid code blocks.`
    : `${base}\n\`\`\`mermaid code blocks render as diagrams in this app; use them for flowcharts and sequence diagrams.`;
}
