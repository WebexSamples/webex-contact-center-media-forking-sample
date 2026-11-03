import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { customFetch } from 'jose';
import { createVerifier } from '../lib/auth.mjs';
import { readConfig } from '../lib/config.mjs';
import { grpc } from '../lib/protocol.mjs';
import { syntheticIdentity } from '../support/synthetic.mjs';

let identity;
before(async () => {
  identity = await syntheticIdentity();
});

test('valid signature and registered bindings are required', async () => {
  assert.equal(
    (await identity.verifyToken(await identity.metadata()))[
      'com.cisco.org.uuid'
    ],
    identity.config.orgId,
  );
});

test('untrusted issuer and wrong algorithm are rejected before fetching keys', async () => {
  let fetches = 0;
  const verify = createVerifier(identity.config, {
    [customFetch]: async () => {
      fetches += 1;
      throw new Error('Unexpected fetch');
    },
  });
  await assert.rejects(
    verify(await identity.metadata({ iss: 'https://attacker.example' })),
  );
  const metadata = new grpc.Metadata();
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  metadata.set(
    'authorization',
    [
      encode({ alg: 'HS256', kid: 'bad' }),
      encode(identity.claims),
      'not-a-signature',
    ].join('.'),
  );
  await assert.rejects(verify(metadata));
  assert.equal(fetches, 0);
});

test('expired, mismatched, and missing claims are rejected', async (t) => {
  const cases = {
    expired: { exp: Math.floor(Date.now() / 1000) - 1 },
    'missing expiration': { exp: undefined },
    audience: { aud: 'other' },
    subject: { sub: 'other' },
    'missing JWT ID': { jti: undefined },
    'empty JWT ID': { jti: '' },
    organization: { 'com.cisco.org.uuid': 'other' },
    'data source URL': { 'com.cisco.datasource.url': 'https://other.example' },
    schema: { 'com.cisco.datasource.schema.uuid': 'other' },
  };
  for (const [name, claims] of Object.entries(cases)) {
    await t.test(name, async () => {
      await assert.rejects(
        identity.verifyToken(await identity.metadata(claims)),
      );
    });
  }
});

test('signature, key ID, and authorization metadata are checked', async () => {
  const other = await syntheticIdentity();
  await assert.rejects(
    identity.verifyToken(
      await other.metadata(identity.claims, { kid: identity.jwk.kid }),
    ),
  );
  await assert.rejects(
    identity.verifyToken(await identity.metadata({}, { kid: 'unknown' })),
  );
  await assert.rejects(identity.verifyToken(new grpc.Metadata()));
  const duplicate = await identity.metadata();
  duplicate.add('authorization', 'second-value');
  await assert.rejects(identity.verifyToken(duplicate));
  const oversized = new grpc.Metadata();
  oversized.set('authorization', 'x'.repeat(8193));
  await assert.rejects(identity.verifyToken(oversized));
});

test('configuration fails closed and requires HTTPS trust URLs', () => {
  assert.throws(() => readConfig({}), /JWS_ISSUERS/);
  const env = {
    JWS_ISSUERS: 'https://identity.example/idb',
    JWS_AUDIENCE: 'audience',
    JWS_SUBJECT: 'subject',
    CUSTOMER_ORG_ID: 'org',
    MEDIA_FORKING_SCHEMA_ID: 'schema',
    DATASOURCE_URL: 'https://media.example',
    TLS_CERT_FILE: './cert.pem',
    TLS_KEY_FILE: './key.pem',
  };
  assert.equal(readConfig(env).port, 8443);
  for (const badUrl of [
    'http://localhost',
    'https://user:password@identity.example',
    'https://identity.example/?query=1',
  ]) {
    assert.throws(() => readConfig({ ...env, JWS_ISSUERS: badUrl }));
  }
  assert.throws(() => readConfig({ ...env, PORT: '0' }), /PORT/);
});
