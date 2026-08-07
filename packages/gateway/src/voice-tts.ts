import { request } from 'undici';

export interface TtsProviderConfig {
  apiUrl: string;
  apiKey: string;
  apiModel: string;
  voiceId: string;
}

/**
 * Synthesizes one sentence via an OpenAI-compatible `/audio/speech`
 * endpoint. Called per-sentence (not on the full digest) so the first
 * segment can start playing before the rest finishes synthesizing.
 * Throws on any failure — the caller degrades to client-side TTS for the
 * rest of the response rather than retrying.
 */
export async function synthesizeSpeech(text: string, config: TtsProviderConfig): Promise<Buffer> {
  const base = config.apiUrl.replace(/\/$/, '');
  const res = await request(`${base}/audio/speech`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.apiModel,
      voice: config.voiceId,
      input: text,
      response_format: 'mp3',
    }),
  });

  if (res.statusCode < 200 || res.statusCode >= 300) {
    const body = await res.body.text().catch(() => '');
    throw new Error(`TTS synthesis failed: ${res.statusCode} ${body}`);
  }

  const arrayBuffer = await res.body.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
