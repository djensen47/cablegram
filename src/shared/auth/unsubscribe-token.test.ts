import { describe, expect, it } from 'vitest';
import { unsubscribeToken, verifyUnsubscribeToken } from './unsubscribe-token.js';

const secret = 'an-unsubscribe-hmac-secret';

describe('unsubscribe token (stateless HMAC, ADR-015)', () => {
  it('is deterministic for the same (secret, newsletter, subscription)', () => {
    expect(unsubscribeToken(secret, 'nl-1', 'sub-1')).toBe(unsubscribeToken(secret, 'nl-1', 'sub-1'));
  });

  it('verifies a token it minted', () => {
    const token = unsubscribeToken(secret, 'nl-1', 'sub-1');
    expect(verifyUnsubscribeToken(secret, 'nl-1', 'sub-1', token)).toBe(true);
  });

  it('rejects a forged / mismatched token', () => {
    expect(verifyUnsubscribeToken(secret, 'nl-1', 'sub-1', 'not-the-real-token')).toBe(false);
    expect(verifyUnsubscribeToken(secret, 'nl-1', 'sub-1', '')).toBe(false);
  });

  it('is bound to the newsletter: a token for one newsletter fails against another (ADR-011)', () => {
    const token = unsubscribeToken(secret, 'nl-1', 'sub-1');
    expect(verifyUnsubscribeToken(secret, 'nl-2', 'sub-1', token)).toBe(false);
  });

  it('is bound to the subscription: a token for one subscription fails against another', () => {
    const token = unsubscribeToken(secret, 'nl-1', 'sub-1');
    expect(verifyUnsubscribeToken(secret, 'nl-1', 'sub-2', token)).toBe(false);
  });

  it('does not verify under a rotated secret (rotation invalidates all links)', () => {
    const token = unsubscribeToken(secret, 'nl-1', 'sub-1');
    expect(verifyUnsubscribeToken('a-different-secret', 'nl-1', 'sub-1', token)).toBe(false);
  });

  it('does not collide across a boundary-ambiguous id split', () => {
    // `(a:b, c)` and `(a, b:c)` must not share a signature. Guarded by ids never
    // containing the separator, but asserted so a future id format change is caught.
    expect(unsubscribeToken(secret, 'a', 'b-c')).not.toBe(unsubscribeToken(secret, 'a-b', 'c'));
  });
});
