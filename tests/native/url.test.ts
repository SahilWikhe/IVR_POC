import { describe, expect, it } from 'vitest';
import { nativeTestUrl } from './url.js';

describe('native database fixture destination guard', () => {
  it('accepts an explicitly named disposable local database', () => {
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
      expect(
        nativeTestUrl(`postgresql://synthetic:fixture@${host}:5432/hostline_native_test`),
      ).toBe(`postgresql://synthetic:fixture@${host}:5432/hostline_native_test`);
    }
  });

  it('rejects production, remote, ambiguous, and query-overridden targets without exposing them', () => {
    for (const url of [
      'postgresql://synthetic:sensitive@example.com/hostline_native_test',
      'postgresql://synthetic:sensitive@127.0.0.1/hostline',
      'postgresql://synthetic:sensitive@127.0.0.1/postgres',
      'postgresql://synthetic:sensitive@127.0.0.1/hostline_native_test?host=example.com',
      'postgresql://synthetic:sensitive@127.0.0.1/hostline_native_test#fragment',
      'https://synthetic:sensitive@127.0.0.1/hostline_native_test',
      'postgresql://127.0.0.1/hostline_native_test',
      'invalid sensitive URL',
    ]) {
      expect(() => nativeTestUrl(url)).toThrow('disposable loopback PostgreSQL');
      try {
        nativeTestUrl(url);
      } catch (error) {
        expect(String(error)).not.toContain('sensitive');
      }
    }
  });
});
