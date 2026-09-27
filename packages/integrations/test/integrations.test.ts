import { createHmac, generateKeyPairSync, createVerify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { githubAppJwt, verifyGithubSignature } from '../src/index.ts';

describe('GitHub webhook signatures', () => {
  const body = Buffer.from('{"a":1}');
  const good = `sha256=${createHmac('sha256', 's3cret').update(body).digest('hex')}`;
  it('accepts the exact signature only', () => {
    expect(verifyGithubSignature('s3cret', body, good)).toBe(true);
    expect(verifyGithubSignature('other', body, good)).toBe(false);
    expect(verifyGithubSignature('s3cret', Buffer.from('{"a":2}'), good)).toBe(false);
    expect(verifyGithubSignature('s3cret', body, undefined)).toBe(false);
    expect(verifyGithubSignature('s3cret', body, good.replace('sha256=', 'sha1='))).toBe(false);
    expect(verifyGithubSignature('', body, good)).toBe(false);
  });
});

describe('GitHub App JWT', () => {
  it('is a verifiable RS256 token with a short, backdated validity window', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwt = githubAppJwt('12345', privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 1_000_000);
    const [h, p, s] = jwt.split('.');
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(JSON.parse(Buffer.from(p!, 'base64url').toString())).toEqual({ iat: 999_940, exp: 1_000_540, iss: '12345' });
    expect(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(s!, 'base64url'))).toBe(true);
  });
});
