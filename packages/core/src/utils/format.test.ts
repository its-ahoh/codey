import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatBytes } from './format';

describe('formatBytes', () => {
  it('returns "0 B" for zero', () => {
    assert.equal(formatBytes(0), '0 B');
  });

  it('formats bytes', () => {
    assert.equal(formatBytes(500), '500 B');
    assert.equal(formatBytes(1), '1 B');
  });

  it('formats kilobytes', () => {
    assert.equal(formatBytes(1024), '1 KB');
    assert.equal(formatBytes(1536), '1.5 KB');
  });

  it('formats megabytes', () => {
    assert.equal(formatBytes(1048576), '1 MB');
    assert.equal(formatBytes(1572864), '1.5 MB');
  });

  it('formats gigabytes', () => {
    assert.equal(formatBytes(1073741824), '1 GB');
  });

  it('formats terabytes', () => {
    assert.equal(formatBytes(1099511627776), '1 TB');
  });

  it('respects custom decimal places', () => {
    assert.equal(formatBytes(1536, 0), '2 KB');
    assert.equal(formatBytes(1536, 1), '1.5 KB');
    assert.equal(formatBytes(1536, 3), '1.5 KB');
  });

  it('handles negative values', () => {
    assert.equal(formatBytes(-1024), '-1 KB');
    assert.equal(formatBytes(-0), '0 B');
  });

  it('does not exceed TB unit for very large values', () => {
    assert.equal(formatBytes(1099511627776 * 1024), '1024 TB');
  });
});
