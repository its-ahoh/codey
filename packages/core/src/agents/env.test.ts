import { describe, it, expect } from 'vitest';
import { withCommonBinPaths } from './env';

describe('withCommonBinPaths', () => {
  it('prepends the usual CLI bin dirs to a minimal GUI PATH', () => {
    const env = { HOME: '/Users/tester', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
    const segments = (withCommonBinPaths(env).PATH || '').split(':');
    expect(segments).toContain('/Users/tester/.local/bin');
    expect(segments).toContain('/opt/homebrew/bin');
    expect(segments).toContain('/usr/local/bin');
    expect(segments.slice(-4)).toEqual(['/usr/bin', '/bin', '/usr/sbin', '/sbin']);
  });

  it('does not duplicate a path that is already present', () => {
    const env = { HOME: '/Users/tester', PATH: '/opt/homebrew/bin:/usr/bin' };
    const segments = (withCommonBinPaths(env).PATH || '').split(':');
    expect(segments.filter(p => p === '/opt/homebrew/bin')).toHaveLength(1);
  });

  it('does not treat a substring match as already present', () => {
    const env = { HOME: '/Users/tester', PATH: '/opt/homebrew/bin/inner:/usr/bin' };
    const segments = (withCommonBinPaths(env).PATH || '').split(':');
    expect(segments).toContain('/opt/homebrew/bin');
  });
});
