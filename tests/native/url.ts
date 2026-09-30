/** Only a deliberately named disposable loopback database may receive fixtures/migrations. */
export function nativeTestUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('TEST_DATABASE_URL must identify a disposable loopback PostgreSQL database.');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    !/^\/hostline_native_test(?:_[a-z0-9]+)?$/.test(url.pathname) ||
    !url.username ||
    url.search ||
    url.hash
  ) {
    // Never include the input URL: it may contain a credential.
    throw new Error('TEST_DATABASE_URL must identify a disposable loopback PostgreSQL database.');
  }
  return url.toString();
}
