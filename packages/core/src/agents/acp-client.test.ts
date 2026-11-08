import { describe, it, expect } from 'vitest';
import { PassThrough, Writable } from 'stream';
import { AcpClient, AcpRequestError } from './acp-client';

/** An output pipe whose reader is gone: every write fails with EPIPE, as an
 *  async 'error' event, the way a dead child's stdin does. */
function brokenPipe(): Writable {
  return new Writable({
    write(_chunk, _enc, cb) {
      const err = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
      cb(err);
    },
  });
}

describe('AcpClient', () => {
  it('fails the request instead of crashing when the agent pipe is broken', async () => {
    const client = new AcpClient(new PassThrough(), brokenPipe());
    // An unheard 'error' event would throw out of the test as an uncaught
    // exception; a rejected request is the contract.
    await expect(client.request('initialize', {})).rejects.toThrow(/agent pipe closed/);
    await expect(client.request('session/new', {})).rejects.toThrow(/agent pipe closed/);
  });

  it('pairs replies with requests and surfaces error replies', async () => {
    const fromAgent = new PassThrough();
    const toAgent = new PassThrough();
    const client = new AcpClient(fromAgent, toAgent);
    const sent: any[] = [];
    toAgent.on('data', d => String(d).trim().split('\n').forEach(l => sent.push(JSON.parse(l))));

    const ok = client.request('initialize', {});
    const bad = client.request('session/new', {});
    await new Promise(r => setImmediate(r));
    fromAgent.write(JSON.stringify({ jsonrpc: '2.0', id: sent[1].id, error: { code: -32000, message: 'Authentication required' } }) + '\n');
    fromAgent.write(JSON.stringify({ jsonrpc: '2.0', id: sent[0].id, result: { protocolVersion: 1 } }) + '\n');

    await expect(ok).resolves.toEqual({ protocolVersion: 1 });
    await expect(bad).rejects.toBeInstanceOf(AcpRequestError);
  });

  it('answers an unknown agent request with method-not-found', async () => {
    const fromAgent = new PassThrough();
    const toAgent = new PassThrough();
    new AcpClient(fromAgent, toAgent);
    const reply = new Promise<any>(r => toAgent.once('data', d => r(JSON.parse(String(d)))));
    fromAgent.write(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'fs/read_text_file', params: {} }) + '\n');
    expect(await reply).toMatchObject({ id: 7, error: { code: -32601 } });
  });
});
