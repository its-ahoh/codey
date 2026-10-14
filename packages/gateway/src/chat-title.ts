/** Reuse only titles that already meet the chat title's single-line limit. */
export function openingChatTitle(classified: string | undefined, generate: () => Promise<string>): Promise<string> {
  const title = classified?.trim();
  return title && title.length <= 40 && !/[\r\n]/.test(title)
    ? Promise.resolve(title) : generate();
}
