import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ConversationAudio, Health, grpc } from '../lib/protocol.mjs';
import { startReceiver } from '../lib/receiver.mjs';
import { prepareRecordingDirectory } from '../lib/recording.mjs';
import {
  syntheticFrames,
  syntheticIdentity,
  streamFrames,
} from '../support/synthetic.mjs';

const identity = await syntheticIdentity();
const received = [];
const recordings = [];
const recordingDirectory = process.env.RECORDING_DIR?.trim()
  ? await prepareRecordingDirectory(process.env.RECORDING_DIR.trim())
  : undefined;
const receiver = await startReceiver({
  address: '127.0.0.1:0',
  credentials: grpc.ServerCredentials.createInsecure(),
  verifyToken: identity.verifyToken,
  recordingDirectory,
  onAudio: async (frame) => received.push(frame),
  log: (event) => {
    console.log(JSON.stringify(event));
    if (event.event === 'recording_saved') recordings.push(event);
  },
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
  // Distinct one-second tones make optional WAV playback easy to check without call audio.
  for (const [index, { audio }] of frames.entries()) {
    audio.audio_data = Buffer.alloc(8000 * 2);
    for (let sample = 0; sample < 8000; sample += 1) {
      audio.audio_data.writeInt16LE(
        Math.round(
          8192 * Math.sin((2 * Math.PI * (440 + index * 220) * sample) / 8000),
        ),
        sample * 2,
      );
    }
  }
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
  assert.deepEqual(
    received.map((frame) => frame.audio.audio_data),
    frames.map((frame) => frame.audio.audio_data),
  );
  if (recordingDirectory) {
    assert.equal(recordings.length, 2);
    for (const recording of recordings) {
      const wav = await readFile(join(recordingDirectory, recording.file));
      assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
      assert.equal(wav.readUInt32LE(4), wav.length - 8);
      assert.deepEqual(
        wav.subarray(44),
        frames.find((frame) => frame.audio.role === recording.role).audio
          .audio_data,
      );
    }
    console.log(
      'WAV demo passed: finalized caller and agent files contain the expected one-second tones.',
    );
  }
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
