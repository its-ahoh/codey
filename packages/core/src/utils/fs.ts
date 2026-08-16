import { promises as fsp } from 'fs';

/** Write a file atomically via a unique temp file + rename, so a crash
 *  mid-write never leaves a truncated target behind. */
export async function atomicWrite(target: string, contents: string): Promise<void> {
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, contents);
  await fsp.rename(tmp, target);
}
