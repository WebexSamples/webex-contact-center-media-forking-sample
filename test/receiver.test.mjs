import assert from 'node:assert/strict';
import { once } from 'node:events';
import { before, test } from 'node:test';
import { ConversationAudio, Health, grpc } from '../lib/protocol.mjs';
import { startReceiver } from '../lib/receiver.mjs';
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
  const events = [];
  const receiver = await startReceiver({
    address: '127.0.0.1:0',
    credentials: grpc.ServerCredentials.createInsecure(),
    verifyToken: identity.verifyToken,
    log: (event) => events.push(event),
    ...options,
  });
  const address = `127.0.0.1:${receiver.port}`;
  const audio = new ConversationAudio(
    address,
    grpc.credentials.createInsecure(),
  );
  const health = new Health(address, grpc.credentials.createInsecure());
  t.after(async () => {
    audio.close();
    health.close();
    await receiver.close();
  });
  return { audio, health, events };
}

test('both media legs preserve bytes and metadata and get one final acknowledgement', async (t) => {
  const received = [];
  const { audio, health, events } = await setup(t, {
    onAudio: async (frame) => received.push(frame),
  });
  const status = await new Promise((resolve, reject) =>
    health.check({}, (error, value) =>
      error ? reject(error) : resolve(value),
    ),
  );
  assert.equal(status.status, 'SERVING');
  const frames = syntheticFrames(identity.config.orgId);
  const responses = await streamFrames(
    audio,
    await identity.metadata(),
    frames,
  );
  assert.deepEqual(responses, [
    { status_message: 'SUCCESS', error_code: 'ERROR_NONE' },
  ]);
  assert.equal(received.length, 2);
  for (let i = 0; i < frames.length; i += 1) {
    assert.deepEqual(received[i].audio, frames[i].audio);
    assert.equal(received[i].conversation_id, frames[i].conversation_id);
    assert.equal(received[i].customer_org_id, frames[i].customer_org_id);
  }
  const logs = JSON.stringify(events);
  assert.ok(events.some((event) => event.event === 'stream_completed'));
  assert.ok(!logs.includes(frames[0].conversation_id));
  assert.ok(!logs.includes(identity.config.orgId));
  assert.ok(!logs.includes('audio_data'));
});

test('initial per-leg metadata is accepted without reaching the audio handler', async (t) => {
  const received = [];
  const { audio, events } = await setup(t, {
    onAudio: async (frame) => received.push(frame),
  });
  const frames = syntheticFrames(identity.config.orgId);
  const headers = frames.map((frame) => ({
    ...frame,
    audio: {
      ...frame.audio,
      audio_data: Buffer.alloc(0),
      audio_timestamp: undefined,
    },
  }));
  const responses = await streamFrames(audio, await identity.metadata(), [
    ...headers,
    ...frames,
  ]);
  assert.equal(received.length, 2);
  assert.equal(
    events.filter((event) => event.event === 'stream_metadata').length,
    2,
  );
  assert.deepEqual(responses, [
    { status_message: 'SUCCESS', error_code: 'ERROR_NONE' },
  ]);
  await assert.rejects(
    streamFrames(audio, await identity.metadata(), [headers[0], headers[0]]),
    { code: grpc.status.INVALID_ARGUMENT },
  );
  const badOrg = { ...headers[0], customer_org_id: 'other' };
  await assert.rejects(
    streamFrames(audio, await identity.metadata(), [badOrg]),
    { code: grpc.status.INVALID_ARGUMENT },
  );
});

test('sparse live packets inherit only validated per-leg metadata and keep absent timestamps', async (t) => {
  const received = [];
  const { audio } = await setup(t, {
    onAudio: async (frame) => received.push(frame),
  });
  const [frame] = syntheticFrames(identity.config.orgId);
  const header = {
    ...frame,
    audio: {
      ...frame.audio,
      audio_data: Buffer.alloc(0),
      audio_timestamp: undefined,
    },
  };
  const packet = {
    ...frame,
    customer_org_id: '',
    audio: {
      ...frame.audio,
      encoding: 'UNSPECIFIED',
      sample_rate_hertz: 0,
      audio_timestamp: undefined,
    },
  };
  await streamFrames(audio, await identity.metadata(), [header, packet]);
  assert.equal(received[0].customer_org_id, identity.config.orgId);
  assert.equal(received[0].audio.encoding, frame.audio.encoding);
  assert.equal(
    received[0].audio.sample_rate_hertz,
    frame.audio.sample_rate_hertz,
  );
  assert.equal(received[0].audio.audio_timestamp, null);
  const invalid = [
    { ...packet, customer_org_id: 'other' },
    { ...packet, conversation_id: 'other' },
    { ...packet, audio: { ...packet.audio, role_id: 'other' } },
    { ...packet, audio: { ...packet.audio, sample_rate_hertz: 44100 } },
    {
      ...packet,
      audio: { ...packet.audio, audio_timestamp: { seconds: '1', nanos: -1 } },
    },
  ];
  for (const bad of invalid) {
    await assert.rejects(
      streamFrames(audio, await identity.metadata(), [header, bad]),
      { code: grpc.status.INVALID_ARGUMENT },
    );
  }
});

test('unauthenticated media is rejected before invoking the audio handler', async (t) => {
  let calls = 0;
  const { audio } = await setup(t, {
    onAudio: async () => {
      calls += 1;
    },
  });
  await assert.rejects(
    streamFrames(
      audio,
      new grpc.Metadata(),
      syntheticFrames(identity.config.orgId),
    ),
    { code: grpc.status.UNAUTHENTICATED },
  );
  assert.equal(calls, 0);
});

test('concurrent calls and multiple participants in one role stay separate', async (t) => {
  const received = [];
  const { audio } = await setup(t, {
    onAudio: async (frame) => received.push(frame),
  });
  const first = syntheticFrames(identity.config.orgId);
  const second = syntheticFrames(identity.config.orgId);
  const extraLeg = syntheticFrames(identity.config.orgId)[0];
  extraLeg.conversation_id = first[0].conversation_id;
  await Promise.all([
    streamFrames(audio, await identity.metadata(), [...first, extraLeg]),
    streamFrames(audio, await identity.metadata(), second),
  ]);
  assert.equal(new Set(received.map((frame) => frame.conversation_id)).size, 2);
  assert.equal(new Set(received.map((frame) => frame.audio.role_id)).size, 5);
});

test('declared encodings, rates, and variable frame sizes pass through without transcoding', async (t) => {
  const received = [];
  const { audio } = await setup(t, {
    onAudio: async (frame) => received.push(frame),
  });
  for (const encoding of ['LINEAR16', 'MULAW', 'ALAW']) {
    for (const rate of [8000, 16000]) {
      const [frame] = syntheticFrames(identity.config.orgId);
      frame.audio.encoding = encoding;
      frame.audio.sample_rate_hertz = rate;
      frame.audio.audio_data = Buffer.alloc(
        encoding === 'LINEAR16' ? 18 : 17,
        7,
      );
      await streamFrames(audio, await identity.metadata(), [frame]);
    }
  }
  assert.equal(received.length, 6);
  assert.equal(received[0].audio.audio_data.length, 18);
  assert.equal(received[2].audio.audio_data.length, 17);
});

test('cross-organization, changed conversation, malformed format, and leg limits fail explicitly', async (t) => {
  const { audio } = await setup(t, { limits: { maxLegs: 1 } });
  const cases = [
    (frames) => {
      frames[0].customer_org_id = 'other';
      return [frames[0]];
    },
    (frames) => {
      frames[1].conversation_id = 'other';
      return frames;
    },
    (frames) => {
      frames[0].audio.encoding = 'UNSPECIFIED';
      return [frames[0]];
    },
    (frames) => {
      frames[0].audio.sample_rate_hertz = 44100;
      return [frames[0]];
    },
    (frames) => {
      frames[0].audio.audio_data = Buffer.alloc(0);
      return [frames[0]];
    },
    (frames) => {
      frames[0].audio.audio_timestamp.nanos = -1;
      return [frames[0]];
    },
  ];
  for (const mutate of cases) {
    await assert.rejects(
      streamFrames(
        audio,
        await identity.metadata(),
        mutate(syntheticFrames(identity.config.orgId)),
      ),
      { code: grpc.status.INVALID_ARGUMENT },
    );
  }
  await assert.rejects(
    streamFrames(
      audio,
      await identity.metadata(),
      syntheticFrames(identity.config.orgId),
    ),
    { code: grpc.status.RESOURCE_EXHAUSTED },
  );
});

test('frame rejection diagnostics expose field names without payload or identity values', async (t) => {
  const { audio, events } = await setup(t);
  const [frame] = syntheticFrames(identity.config.orgId);
  frame.customer_org_id = 'private-other-org';
  frame.audio.role_id = '';
  frame.audio.audio_timestamp = undefined;
  await assert.rejects(
    streamFrames(audio, await identity.metadata(), [frame]),
    {
      code: grpc.status.INVALID_ARGUMENT,
    },
  );
  const rejected = events.find((event) => event.event === 'frame_rejected');
  assert.deepEqual(rejected.invalid_fields, [
    'customer_org_id',
    'audio.role_id',
    'audio.audio_timestamp',
  ]);
  const logs = JSON.stringify(events);
  for (const sensitive of [
    frame.customer_org_id,
    frame.conversation_id,
    identity.config.orgId,
  ]) {
    assert.ok(!logs.includes(sensitive));
  }
  assert.ok(!logs.includes('audio_data'));
});

test('a slow processor exhausts the bounded queue instead of accepting unlimited audio', async (t) => {
  let aborted = false;
  const { audio } = await setup(t, {
    limits: { maxQueueBytes: 320 },
    onAudio: async (_frame, { signal }) => {
      await once(signal, 'abort');
      aborted = true;
    },
  });
  await assert.rejects(
    streamFrames(
      audio,
      await identity.metadata(),
      syntheticFrames(identity.config.orgId),
    ),
    { code: grpc.status.RESOURCE_EXHAUSTED },
  );
  assert.equal(aborted, true);
});

test('tiny frames cannot bypass the queue frame-count limit', async (t) => {
  const { audio } = await setup(t, {
    limits: { maxQueuedFrames: 1 },
    onAudio: async (_frame, { signal }) => {
      await once(signal, 'abort');
    },
  });
  const [frame] = syntheticFrames(identity.config.orgId);
  frame.audio.encoding = 'MULAW';
  frame.audio.audio_data = Buffer.alloc(1);
  await assert.rejects(
    streamFrames(audio, await identity.metadata(), [frame, frame, frame]),
    { code: grpc.status.RESOURCE_EXHAUSTED },
  );
});

test('audio and protobuf message size limits reject oversized requests', async (t) => {
  const { audio } = await setup(t);
  const [frame] = syntheticFrames(identity.config.orgId);
  frame.audio.audio_data = Buffer.alloc(64 * 1024 + 1);
  await assert.rejects(
    streamFrames(audio, await identity.metadata(), [frame]),
    { code: grpc.status.INVALID_ARGUMENT },
  );
  frame.audio.audio_data = Buffer.alloc(128 * 1024);
  await assert.rejects(
    streamFrames(audio, await identity.metadata(), [frame]),
    { code: grpc.status.RESOURCE_EXHAUSTED },
  );
});

test('frame boundaries and changes in declared format are passed to the processor', async (t) => {
  const received = [];
  const { audio } = await setup(t, {
    onAudio: async (frame) => received.push(frame),
  });
  const [first] = syntheticFrames(identity.config.orgId);
  first.audio.audio_data = Buffer.alloc(17);
  const second = {
    ...first,
    audio: { ...first.audio, encoding: 'MULAW', sample_rate_hertz: 16000 },
  };
  await streamFrames(audio, await identity.metadata(), [first, second]);
  assert.equal(received[0].audio.audio_data.length, 17);
  assert.equal(received[1].audio.encoding, 'MULAW');
  assert.equal(received[1].audio.sample_rate_hertz, 16000);
});

test('handler failures cannot produce a success acknowledgement', async (t) => {
  const { audio } = await setup(t, {
    onAudio: async () => {
      throw new Error('processor failure');
    },
  });
  await assert.rejects(
    streamFrames(
      audio,
      await identity.metadata(),
      syntheticFrames(identity.config.orgId),
    ),
    { code: grpc.status.INTERNAL },
  );
});

test('client cancellation aborts processing', async (t) => {
  const entered = Promise.withResolvers();
  const aborted = Promise.withResolvers();
  const { audio } = await setup(t, {
    onAudio: async (_frame, { signal }) => {
      entered.resolve();
      await once(signal, 'abort');
      aborted.resolve();
    },
  });
  const call = audio.streamConversationAudio(await identity.metadata(), {
    deadline: Date.now() + 5000,
  });
  call.on('error', () => {});
  call.write(syntheticFrames(identity.config.orgId)[0]);
  await entered.promise;
  call.cancel();
  await aborted.promise;
});

test('capacity is global across connections and returns after stream completion', async (t) => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const { audio } = await setup(t, {
    limits: { maxStreams: 1 },
    onAudio: async () => {
      entered.resolve();
      await release.promise;
    },
  });
  const first = streamFrames(audio, await identity.metadata(), [
    syntheticFrames(identity.config.orgId)[0],
  ]);
  await entered.promise;
  const other = new ConversationAudio(
    audio.getChannel().getTarget(),
    grpc.credentials.createInsecure(),
    { 'grpc.use_local_subchannel_pool': 1 },
  );
  try {
    await assert.rejects(
      streamFrames(
        other,
        await identity.metadata(),
        syntheticFrames(identity.config.orgId),
      ),
      { code: grpc.status.RESOURCE_EXHAUSTED },
    );
    release.resolve();
    await first;
    await streamFrames(other, await identity.metadata(), [
      syntheticFrames(identity.config.orgId)[0],
    ]);
  } finally {
    release.resolve();
    other.close();
  }
});

test('idle streams expire', async (t) => {
  const { audio } = await setup(t, { limits: { idleTimeoutMs: 50 } });
  const call = audio.streamConversationAudio(await identity.metadata(), {
    deadline: Date.now() + 5000,
  });
  await assert.rejects(once(call, 'data'), {
    code: grpc.status.DEADLINE_EXCEEDED,
  });
});
