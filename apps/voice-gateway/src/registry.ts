import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

interface CallGrant {
  tokenHash: Buffer;
  expiresAt: number;
  state: 'pending' | 'active' | 'ended';
  response: string;
  onEnd?: () => void;
}

/** Sandbox single-process ownership. Entries are retained for the entire process lifetime. */
export class CallRegistry {
  private readonly calls = new Map<string, CallGrant>();

  constructor(
    private readonly maxConcurrent: number,
    private readonly now: () => number = Date.now,
    private readonly maxRecords = 10_000,
  ) {}

  incoming(callSid: string, responseFor: (token: string) => string): string | undefined {
    const existing = this.calls.get(callSid);
    // A duplicate receives exactly the original instructions, even after the grant is spent.
    if (existing) return existing.response;
    if (this.calls.size >= this.maxRecords || this.activeCount >= this.maxConcurrent)
      return undefined;
    const token = randomBytes(32).toString('hex');
    const response = responseFor(token);
    this.calls.set(callSid, {
      tokenHash: createHash('sha256').update(token).digest(),
      expiresAt: this.now() + 30_000,
      state: 'pending',
      response,
    });
    return response;
  }

  redeem(callSid: string, token: string, onEnd: () => void): boolean {
    const grant = this.calls.get(callSid);
    if (
      !grant ||
      grant.state !== 'pending' ||
      grant.expiresAt <= this.now() ||
      !/^[a-f0-9]{64}$/.test(token)
    )
      return false;
    if (!timingSafeEqual(grant.tokenHash, createHash('sha256').update(token).digest()))
      return false;
    grant.state = 'active';
    grant.onEnd = onEnd;
    return true;
  }

  end(callSid: string): boolean {
    const grant = this.calls.get(callSid);
    if (!grant) {
      // Status callbacks can precede the incoming webhook. Preserve terminality
      // so that a delayed/replayed incoming event cannot create a new grant.
      if (this.calls.size >= this.maxRecords) return false;
      this.calls.set(callSid, {
        tokenHash: Buffer.alloc(32),
        expiresAt: this.now(),
        state: 'ended',
        response: '<Response><Hangup/></Response>',
      });
      return true;
    }
    if (grant.state !== 'ended') {
      grant.state = 'ended';
      const onEnd = grant.onEnd;
      delete grant.onEnd;
      onEnd?.();
    }
    return true;
  }

  get activeCount(): number {
    let count = 0;
    for (const grant of this.calls.values())
      if (grant.state === 'active' || (grant.state === 'pending' && grant.expiresAt > this.now()))
        count += 1;
    return count;
  }
}
