import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmod, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { ConversationAudio, grpc } from '../lib/protocol.mjs';
import { startReceiver } from '../lib/receiver.mjs';
import { prepareRecordingDirectory } from '../lib/recording.mjs';
import {
  syntheticFrames,
  syntheticIdentity,
  streamFrames,
} from '../support/synthetic.mjs';

let identity;
before(async () => {
  identity = await syntheticIdentity();
});

async function setup(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'forking-wav-'));
  const events = [];
  const receiver = await startReceiver({
    address: '127.0.0.1:0',
    credentials: grpc.ServerCredentials.createInsecure(),
    verifyToken: identity.verifyToken,
    recordingDirectory: await prepareRecordingDirectory(directory),
    log: (event) => events.push(event),
    ...options,
  });
  const audio = new ConversationAudio(
    `127.0.0.1:${receiver.port}`,
    grpc.credentials.createInsecure(),
  );
  t.after(async () => {
    audio.close();
    await receiver.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, events, audio, receiver };
}

async function readWav(directory, name, encoding, rate, expected) {
  const path = join(directory, name);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const data = await readFile(path);
  assert.equal(data.toString('ascii', 0, 4), 'RIFF');
  assert.equal(data.readUInt32LE(4), data.length - 8);
  assert.equal(data.toString('ascii', 8, 16), 'WAVEfmt ');
  assert.equal(
    data.readUInt16LE(20),
    { LINEAR16: 1, MULAW: 7, ALAW: 6 }[encoding],
  );
  assert.equal(data.readUInt16LE(22), 1);
  assert.equal(data.readUInt32LE(24), rate);
  assert.equal(data.readUInt32LE(28), rate * (encoding === 'LINEAR16' ? 2 : 1));
  assert.equal(data.readUInt16LE(34), encoding === 'LINEAR16' ? 16 : 8);
  const start = encoding === 'LINEAR16' ? 44 : 58;
  if (encoding !== 'LINEAR16') {
    assert.equal(data.readUInt16LE(36), 0);
    assert.equal(data.toString('ascii', 38, 42), 'fact');
    assert.equal(data.readUInt32LE(46), expected.length);
  }
  assert.equal(data.toString('ascii', start - 8, start - 4), 'data');
  assert.equal(data.readUInt32LE(start - 4), expected.length);
  assert.deepEqual(data.subarray(start, start + expected.length), expected);
  assert.equal(data.length, start + expected.length + (expected.length % 2));
}

test('native WAV recordings preserve both roles, every encoding/rate and odd G.711 padding', async (t) => {
  const { directory, audio, events } = await setup(t);
  for (const encoding of ['LINEAR16', 'MULAW', 'ALAW']) {
    for (const rate of [8000, 16000]) {
      const frames = syntheticFrames(identity.config.orgId);
      for (const frame of frames) {
        frame.audio.encoding = encoding;
        frame.audio.sample_rate_hertz = rate;
        frame.audio.audio_data = Buffer.alloc(
          encoding === 'LINEAR16' ? 18 : 17,
          0xa5,
        );
      }
      await streamFrames(audio, await identity.metadata(), frames);
      const saved = events
        .filter((event) => event.event === 'recording_saved')
        .slice(-2);
      assert.deepEqual(saved.map((event) => event.role).sort(), [
        'AGENT',
        'CALLER',
      ]);
      for (const event of saved)
        await readWav(
          directory,
          event.file,
          encoding,
          rate,
          frames[0].audio.audio_data,
        );
    }
  }
  assert.equal((await readdir(directory)).length, 12);
  const logs = JSON.stringify(events);
  assert.ok(!logs.includes(identity.config.orgId));
  assert.ok(
    !logs.includes(syntheticFrames(identity.config.orgId)[0].conversation_id),
  );
});

test('sparse packets record after metadata; split PCM samples and format changes are handled', async (t) => {
  const { directory, audio, events } = await setup(t);
  const [frame] = syntheticFrames(identity.config.orgId);
  const header = {
    ...frame,
    audio: {
      ...frame.audio,
      audio_data: Buffer.alloc(0),
      audio_timestamp: undefined,
    },
  };
  const packet = (data) => ({
    ...frame,
    customer_org_id: '',
    audio: {
      ...frame.audio,
      encoding: 'UNSPECIFIED',
      sample_rate_hertz: 0,
      audio_timestamp: undefined,
      audio_data: Buffer.from(data),
    },
  });
  await streamFrames(audio, await identity.metadata(), [
    header,
    packet([1]),
    packet([2, 3, 4]),
    {
      ...frame,
      audio: {
        ...frame.audio,
        encoding: 'ALAW',
        sample_rate_hertz: 16000,
        audio_data: Buffer.from([5]),
      },
    },
  ]);
  const saved = events.filter((event) => event.event === 'recording_saved');
  assert.equal(saved.length, 2);
  await readWav(
    directory,
    saved[0].file,
    'LINEAR16',
    8000,
    Buffer.from([1, 2, 3, 4]),
  );
  await readWav(directory, saved[1].file, 'ALAW', 16000, Buffer.from([5]));
  assert.deepEqual(
    saved.map((event) => event.segment),
    [1, 2],
  );
  assert.ok(
    events.findIndex((event) => event.event === 'stream_completed') >
      events.findLastIndex((event) => event.event === 'recording_saved'),
  );
});

test('concurrent and reconnected streams with identical untrusted IDs have distinct safe files', async (t) => {
  const { directory, audio } = await setup(t);
  const frames = syntheticFrames(identity.config.orgId).map((frame) => ({
    ...frame,
    conversation_id: '../../escape',
    audio: { ...frame.audio, role_id: '../../escape' },
  }));
  await Promise.all(
    [1, 2, 3].map(async () =>
      streamFrames(audio, await identity.metadata(), frames),
    ),
  );
  const files = await readdir(directory);
  assert.equal(files.length, 6);
  assert.ok(
    files.every((file) => /^[a-f0-9-]+_[12]_(CALLER|AGENT)_1\.wav$/.test(file)),
  );
});

test('metadata-only and rejected streams create no recordings', async (t) => {
  const { directory, audio } = await setup(t);
  const [frame] = syntheticFrames(identity.config.orgId);
  await streamFrames(audio, await identity.metadata(), [
    {
      ...frame,
      audio: {
        ...frame.audio,
        audio_data: Buffer.alloc(0),
        audio_timestamp: undefined,
      },
    },
  ]);
  await assert.rejects(streamFrames(audio, new grpc.Metadata(), [frame]), {
    code: grpc.status.UNAUTHENTICATED,
  });
  await assert.rejects(
    streamFrames(audio, await identity.metadata(), [
      { ...frame, customer_org_id: 'wrong' },
    ]),
    { code: grpc.status.INVALID_ARGUMENT },
  );
  assert.deepEqual(await readdir(directory), []);
});

test('cancellation saves accepted audio and shutdown waits for recording cleanup', async (t) => {
  let entered;
  const processing = new Promise((resolve) => {
    entered = resolve;
  });
  const { directory, audio, receiver } = await setup(t, {
    onAudio: async (_frame, { signal }) => {
      entered();
      await once(signal, 'abort');
    },
  });
  const call = audio.streamConversationAudio(await identity.metadata());
  call.on('error', () => {});
  const [frame] = syntheticFrames(identity.config.orgId);
  call.write(frame);
  await processing;
  call.cancel();
  await receiver.close();
  const files = await readdir(directory);
  assert.equal(files.length, 1);
  await readWav(directory, files[0], 'LINEAR16', 8000, frame.audio.audio_data);
});

test('recording failures and incomplete PCM samples never acknowledge success', async (t) => {
  const { directory, audio, events } = await setup(t);
  const [frame] = syntheticFrames(identity.config.orgId);
  frame.audio.audio_data = Buffer.from([1]);
  await assert.rejects(
    streamFrames(audio, await identity.metadata(), [frame]),
    { code: grpc.status.INTERNAL },
  );
  assert.ok(
    (await readdir(directory)).every((name) => name.endsWith('.partial')),
  );
  assert.ok(!events.some((event) => event.event === 'stream_completed'));
  // A missing destination models a failed filesystem write without test-only hooks.
  await rm(directory, { recursive: true });
  frame.audio.audio_data = Buffer.from([1, 2]);
  await assert.rejects(
    streamFrames(audio, await identity.metadata(), [frame]),
    { code: grpc.status.INTERNAL },
  );
});

test('queue overload finalizes written audio without acknowledging dropped frames', async (t) => {
  let entered;
  const processing = new Promise((resolve) => {
    entered = resolve;
  });
  const [frame] = syntheticFrames(identity.config.orgId);
  const { directory, audio, receiver, events } = await setup(t, {
    limits: { maxQueueBytes: frame.audio.audio_data.length },
    onAudio: async (_frame, { signal }) => {
      entered();
      await once(signal, 'abort');
    },
  });
  const call = audio.streamConversationAudio(await identity.metadata());
  const failed = once(call, 'error');
  call.write(frame);
  await processing;
  call.write(frame);
  assert.equal((await failed)[0].code, grpc.status.RESOURCE_EXHAUSTED);
  await receiver.close();
  const files = await readdir(directory);
  assert.equal(files.length, 1);
  await readWav(directory, files[0], 'LINEAR16', 8000, frame.audio.audio_data);
  assert.ok(!events.some((event) => event.event === 'stream_completed'));
});

test('recording directory must be private and recording remains disabled by default', async (t) => {
  const { directory, audio } = await setup(t, {
    recordingDirectory: undefined,
  });
  await streamFrames(
    audio,
    await identity.metadata(),
    syntheticFrames(identity.config.orgId),
  );
  assert.deepEqual(await readdir(directory), []);
  await chmod(directory, 0o755);
  await assert.rejects(
    prepareRecordingDirectory(directory),
    /private directory/,
  );
});

test('recording readiness rejects a private but unwritable directory', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'forking-readonly-'));
  t.after(async () => {
    await chmod(directory, 0o700);
    await rm(directory, { recursive: true, force: true });
  });
  await chmod(directory, 0o500);
  await assert.rejects(prepareRecordingDirectory(directory), /mode 0700/);
});

test(
  'forced shutdown cancels an active processor and finalizes its WAV before returning',
  { timeout: 10_000 },
  async (t) => {
    const entered = Promise.withResolvers();
    let aborted = false;
    const { directory, audio, receiver, events } = await setup(t, {
      onAudio: async (_frame, { signal }) => {
        entered.resolve();
        await once(signal, 'abort');
        aborted = true;
      },
    });
    const call = audio.streamConversationAudio(await identity.metadata());
    call.on('error', () => {});
    const [frame] = syntheticFrames(identity.config.orgId);
    call.write(frame);
    await entered.promise;
    await receiver.close();
    assert.equal(aborted, true);
    const files = await readdir(directory);
    assert.equal(files.length, 1);
    await readWav(
      directory,
      files[0],
      'LINEAR16',
      8000,
      frame.audio.audio_data,
    );
    assert.ok(!events.some((event) => event.event === 'stream_completed'));
  },
);

test('repeated format changes stop at the recording segment limit', async (t) => {
  const { directory, audio, events } = await setup(t);
  const [frame] = syntheticFrames(identity.config.orgId);
  const frames = Array.from({ length: 33 }, (_, index) => ({
    ...frame,
    audio: {
      ...frame.audio,
      encoding: index % 2 ? 'ALAW' : 'MULAW',
      audio_data: Buffer.from([0xff]),
    },
  }));
  await assert.rejects(streamFrames(audio, await identity.metadata(), frames), {
    code: grpc.status.INTERNAL,
  });
  assert.equal((await readdir(directory)).length, 32);
  assert.ok(!events.some((event) => event.event === 'stream_completed'));
});
