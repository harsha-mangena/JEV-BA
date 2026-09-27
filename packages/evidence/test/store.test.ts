import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertSafeKey, FsArtifactStore, signV4 } from '../src/index.ts';

describe('SigV4', () => {
  it('reproduces the AWS documentation example (GET Object with Range)', () => {
    // docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html — "Example: GET Object"
    const h = signV4({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      headers: { range: 'bytes=0-9' },
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      region: 'us-east-1',
      service: 's3',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      date: new Date('2013-05-24T00:00:00Z'),
    });
    expect(h.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });
});

describe('filesystem artifact store', () => {
  it('stores, lists and deletes by prefix and rejects unsafe keys', async () => {
    const s = new FsArtifactStore(await mkdtemp(join(tmpdir(), 'qa-store-')));
    await s.put('acme/shop/run_1/a.txt', Buffer.from('a'));
    await s.put('acme/shop/run_1/sub/b.txt', Buffer.from('b'));
    await s.put('acme/shop/run_2/c.txt', Buffer.from('c'));
    expect(await s.list('acme/shop/run_1')).toEqual(['acme/shop/run_1/a.txt', 'acme/shop/run_1/sub/b.txt']);
    expect((await s.get('acme/shop/run_1/sub/b.txt'))!.toString()).toBe('b');
    expect(await s.get('acme/shop/none')).toBeNull();
    expect(await s.deletePrefix('acme/shop/run_1')).toBe(2);
    expect(await s.list('acme/shop')).toEqual(['acme/shop/run_2/c.txt']);
    for (const bad of ['../x', '/abs', 'a/../b', 'a//b', 'a\\b']) expect(() => assertSafeKey(bad)).toThrow();
  });
});
