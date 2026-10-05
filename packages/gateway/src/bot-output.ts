/** Some adapters return their answer without streaming it (or stream only a
 * prefix). Publish missing text before the member message is finalized. */
export function botOutputStream(emit?: (text: string) => void) {
  let streamed = '';
  const onStream = (text: string) => { streamed += text; emit?.(text); };
  return {
    onStream,
    complete(output?: string | null): void {
      if (!output?.trim()) return;
      if (!streamed.trim()) onStream(output);
      else if (output.length > streamed.length && output.startsWith(streamed)) onStream(output.slice(streamed.length));
    },
  };
}
