import { randomUUID } from 'node:crypto';
import { SignJWT, customFetch, exportJWK, generateKeyPair } from 'jose';
import { createVerifier } from '../lib/auth.mjs';
import { grpc } from '../lib/protocol.mjs';

// Temporary signing material for the local demo/tests; never used by npm start.
export async function syntheticIdentity() {
  const { publicKey, privateKey } = await generateKeyPair('RS256', {
    modulusLength: 2048,
  });
  const kid = randomUUID();
  const jwk = {
    ...(await exportJWK(publicKey)),
    kid,
    alg: 'RS256',
    use: 'sig',
  };
  const config = {
    issuers: ['https://identity.example/idb'],
    audience: 'synthetic-receiver',
    subject: 'synthetic-data-source',
    orgId: randomUUID(),
    schemaId: randomUUID(),
    datasourceUrl: 'https://media.example',
  };
  const claims = {
    iss: config.issuers[0],
    aud: config.audience,
    sub: config.subject,
    exp: Math.floor(Date.now() / 1000) + 300,
    jti: randomUUID(),
    'com.cisco.org.uuid': config.orgId,
    'com.cisco.datasource.url': config.datasourceUrl,
    'com.cisco.datasource.schema.uuid': config.schemaId,
  };
  const jwksOptions = {
    [customFetch]: async () =>
      new Response(JSON.stringify({ keys: [jwk] }), {
        headers: { 'content-type': 'application/json' },
      }),
  };
  const sign = (overrides = {}, header = {}) =>
    new SignJWT({ ...claims, ...overrides })
      .setProtectedHeader({ alg: 'RS256', kid, ...header })
      .sign(privateKey);
  const metadata = async (overrides, header) => {
    const result = new grpc.Metadata();
    result.set('authorization', 'Bearer ' + (await sign(overrides, header)));
    return result;
  };
  return {
    config,
    claims,
    jwk,
    jwksOptions,
    sign,
    metadata,
    verifyToken: createVerifier(config, jwksOptions),
  };
}

export function syntheticFrames(orgId) {
  const conversation_id = randomUUID();
  const timestamp = {
    seconds: String(Math.floor(Date.now() / 1000)),
    nanos: 0,
  };
  return ['CALLER', 'AGENT'].map((role) => ({
    conversation_id,
    customer_org_id: orgId,
    audio: {
      audio_data: Buffer.alloc(320), // 20 ms of LINEAR16 silence at 8 kHz.
      encoding: 'LINEAR16',
      sample_rate_hertz: 8000,
      audio_timestamp: timestamp,
      role,
      role_id: randomUUID(),
    },
  }));
}

export function streamFrames(client, metadata, frames) {
  return new Promise((resolve, reject) => {
    const call = client.streamConversationAudio(metadata, {
      deadline: Date.now() + 5000,
    });
    const responses = [];
    call.on('data', (response) => responses.push(response));
    call.on('error', reject);
    call.on('end', () => resolve(responses));
    for (const frame of frames) call.write(frame);
    call.end();
  });
}
