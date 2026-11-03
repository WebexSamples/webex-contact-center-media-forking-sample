import assert from 'node:assert/strict';
import { ConversationAudio, Health, grpc } from '../lib/protocol.mjs';
import { startReceiver } from '../lib/receiver.mjs';
import {
  syntheticFrames,
  syntheticIdentity,
  streamFrames,
} from '../support/synthetic.mjs';

const identity = await syntheticIdentity();
const received = [];
const receiver = await startReceiver({
  address: '127.0.0.1:0',
  credentials: grpc.ServerCredentials.createInsecure(),
  verifyToken: identity.verifyToken,
  onAudio: async (frame) => received.push(frame),
});
const address = `127.0.0.1:${receiver.port}`;
const audio = new ConversationAudio(address, grpc.credentials.createInsecure());
const health = new Health(address, grpc.credentials.createInsecure());
try {
  const readiness = await new Promise((resolve, reject) =>
    health.check({}, { deadline: Date.now() + 5000 }, (error, value) =>
      error ? reject(error) : resolve(value),
    ),
  );
  assert.equal(readiness.status, 'SERVING');
  const frames = syntheticFrames(identity.config.orgId);
  const responses = await streamFrames(
    audio,
    await identity.metadata(),
    frames,
  );
  assert.deepEqual(responses, [
    { status_message: 'SUCCESS', error_code: 'ERROR_NONE' },
  ]);
  assert.deepEqual(
    received.map((frame) => frame.audio.role),
    ['CALLER', 'AGENT'],
  );
  await assert.rejects(streamFrames(audio, new grpc.Metadata(), frames), {
    code: grpc.status.UNAUTHENTICATED,
  });
  console.log(
    'Demo passed: health SERVING, authenticated CALLER + AGENT audio, one final SUCCESS, unauthenticated call rejected.',
  );
  console.log(
    'Synthetic local test only. No Webex organization was contacted.',
  );
} finally {
  audio.close();
  health.close();
  await receiver.close();
}
