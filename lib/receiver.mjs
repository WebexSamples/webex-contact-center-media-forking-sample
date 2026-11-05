import { randomUUID } from 'node:crypto';
import { ConversationAudio, Health, grpc } from './protocol.mjs';
import { handleAudio } from './audio.mjs';
import { createWavRecorder } from './recording.mjs';

export const LIMITS = Object.freeze({
  maxStreams: 16,
  maxMessageBytes: 128 * 1024,
  maxFrameBytes: 64 * 1024,
  maxQueueBytes: 1024 * 1024,
  maxQueuedFrames: 128,
  maxLegs: 16,
  idleTimeoutMs: 60_000,
  maxDurationMs: 2 * 60 * 60 * 1000,
});

const identifier = (value) =>
  typeof value === 'string' && value.length > 0 && value.length <= 256;
const defaultLog = (event) => console.log(JSON.stringify(event));

export async function startReceiver({
  address,
  credentials,
  verifyToken,
  onAudio = handleAudio,
  recordingDirectory,
  log = defaultLog,
  limits: overrides = {},
}) {
  const limits = { ...LIMITS, ...overrides };
  const server = new grpc.Server({
    'grpc.max_receive_message_length': limits.maxMessageBytes,
    'grpc.max_concurrent_streams': limits.maxStreams,
  });
  const active = new Set();
  const pending = new Set();
  let draining = false;

  server.addService(Health.service, {
    check: (_call, callback) =>
      callback(null, {
        status:
          draining || active.size >= limits.maxStreams
            ? 'NOT_SERVING'
            : 'SERVING',
      }),
  });

  server.addService(ConversationAudio.service, {
    streamConversationAudio: (call) => {
      call.on('error', () => {});
      if (draining || active.size >= limits.maxStreams) {
        call.emit('error', {
          code: grpc.status.RESOURCE_EXHAUSTED,
          details: 'Receiver at capacity',
        });
        return;
      }
      active.add(call);
      let resolveCleanup;
      const cleanup = new Promise((resolve) => {
        resolveCleanup = resolve;
      });
      pending.add(cleanup);
      const streamId = randomUUID();
      const recorder = recordingDirectory
        ? createWavRecorder(recordingDirectory, streamId, log)
        : undefined;
      const controller = new AbortController();
      const legs = new Map();
      const queue = [];
      let conversationId;
      let queueBytes = 0;
      let running = false;
      let authenticating = true;
      let ended = false;
      let stopped = false;
      let finalizing = false;
      let idleTimer;
      let durationTimer;

      function release() {
        // Retain the slot until pending work settles, even after the peer disconnects.
        if (running || authenticating) return;
        void finish();
      }

      function stop(code, details) {
        if (stopped) return;
        stopped = true;
        clearTimeout(idleTimer);
        clearTimeout(durationTimer);
        controller.abort();
        queue.length = 0;
        queueBytes = 0;
        if (code !== undefined) {
          log({ event: 'stream_failed', stream_id: streamId, code });
          call.emit('error', { code, details });
        }
        release();
      }

      function resetIdle() {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(
          () =>
            stop(
              grpc.status.DEADLINE_EXCEEDED,
              'No media received before idle timeout',
            ),
          limits.idleTimeoutMs,
        );
        idleTimer.unref();
      }

      async function finish() {
        if (
          running ||
          authenticating ||
          finalizing ||
          (!stopped && (!ended || queue.length))
        )
          return;
        finalizing = true;
        try {
          await recorder?.close();
          if (stopped) return;
          stopped = true;
          clearTimeout(idleTimer);
          clearTimeout(durationTimer);
          controller.abort();
          call.write({ status_message: 'SUCCESS', error_code: 'ERROR_NONE' });
          call.end();
          log({
            event: 'stream_completed',
            stream_id: streamId,
            legs: [...legs.values()].map(({ role, frames, bytes }) => ({
              role,
              frames,
              bytes,
            })),
          });
        } catch {
          log({ event: 'recording_failed', stream_id: streamId });
          stop(grpc.status.INTERNAL, 'Audio recording could not be finalized');
        } finally {
          active.delete(call);
          pending.delete(cleanup);
          resolveCleanup();
        }
      }

      async function drain() {
        if (running || stopped) return;
        running = true;
        try {
          while (queue.length && !stopped) {
            const frame = queue.shift();
            await recorder?.write(frame, { signal: controller.signal });
            await onAudio(frame, { signal: controller.signal });
            if (stopped) break;
            queueBytes -= frame.audio.audio_data.length;
            const leg = legs.get(
              JSON.stringify([frame.audio.role, frame.audio.role_id]),
            );
            leg.frames += 1;
            leg.bytes += frame.audio.audio_data.length;
            if (leg.frames === 1 || leg.frames % 100 === 0) {
              log({
                event: 'media_received',
                stream_id: streamId,
                leg: leg.index,
                role: leg.role,
                encoding: frame.audio.encoding,
                sample_rate_hertz: frame.audio.sample_rate_hertz,
                frames: leg.frames,
                bytes: leg.bytes,
                audio_timestamp: frame.audio.audio_timestamp,
              });
            }
          }
        } catch {
          stop(grpc.status.INTERNAL, 'Audio handler failed');
        } finally {
          running = false;
          if (stopped) release();
          else finish();
        }
      }

      call.on('cancelled', () => stop());
      call.on('error', () => stop());
      resetIdle();
      durationTimer = setTimeout(
        () =>
          stop(
            grpc.status.DEADLINE_EXCEEDED,
            'Maximum stream duration reached',
          ),
        limits.maxDurationMs,
      );
      durationTimer.unref();

      // Do not attach the data listener until the signed identity is verified.
      void (async () => {
        let claims;
        try {
          claims = await verifyToken(call.metadata);
        } catch {
          stop(
            grpc.status.UNAUTHENTICATED,
            'Missing or invalid media authorization',
          );
        } finally {
          authenticating = false;
          if (stopped) release();
        }
        if (stopped) return;
        call.on('end', () => {
          ended = true;
          finish();
        });
        call.on('data', (frame) => {
          if (stopped) return;
          resetIdle();
          let audio = frame.audio;
          const key = JSON.stringify([audio?.role, audio?.role_id]);
          const metadata = legs.get(key)?.metadata;
          if (metadata && audio) {
            frame = {
              ...frame,
              customer_org_id:
                frame.customer_org_id || metadata.customer_org_id,
              audio: {
                ...audio,
                encoding:
                  audio.encoding === 'UNSPECIFIED'
                    ? metadata.encoding
                    : audio.encoding,
                sample_rate_hertz:
                  audio.sample_rate_hertz === 0
                    ? metadata.sample_rate_hertz
                    : audio.sample_rate_hertz,
              },
            };
            audio = frame.audio;
          }
          const timestamp = audio?.audio_timestamp;
          // Webex opens each leg with format/identity metadata before audio arrives.
          const metadataOnly =
            Buffer.isBuffer(audio?.audio_data) &&
            audio.audio_data.length === 0 &&
            !timestamp &&
            !legs.has(key);
          const invalidFields = Object.entries({
            conversation_id:
              !identifier(frame.conversation_id) ||
              (conversationId !== undefined &&
                frame.conversation_id !== conversationId),
            customer_org_id:
              frame.customer_org_id !== claims['com.cisco.org.uuid'],
            'audio.role_id': !identifier(audio?.role_id),
            'audio.role': !['CALLER', 'AGENT'].includes(audio?.role),
            'audio.encoding': !['LINEAR16', 'MULAW', 'ALAW'].includes(
              audio?.encoding,
            ),
            'audio.sample_rate_hertz': ![8000, 16000].includes(
              audio?.sample_rate_hertz,
            ),
            'audio.audio_data':
              !Buffer.isBuffer(audio?.audio_data) ||
              (!metadataOnly && !audio.audio_data.length) ||
              audio.audio_data.length > limits.maxFrameBytes,
            'audio.audio_timestamp':
              !metadataOnly &&
              ((!timestamp && !metadata) ||
                (timestamp &&
                  (!Number.isSafeInteger(Number(timestamp.seconds)) ||
                    Number(timestamp.seconds) < 0 ||
                    !Number.isInteger(timestamp.nanos) ||
                    timestamp.nanos < 0 ||
                    timestamp.nanos >= 1_000_000_000))),
          })
            .filter(([, invalid]) => invalid)
            .map(([field]) => field);
          if (invalidFields.length) {
            log({
              event: 'frame_rejected',
              stream_id: streamId,
              invalid_fields: invalidFields,
            });
            stop(
              grpc.status.INVALID_ARGUMENT,
              'Invalid audio frame, identity, or conversation',
            );
            return;
          }
          let leg = legs.get(key);
          if (!leg) {
            if (legs.size >= limits.maxLegs) {
              stop(grpc.status.RESOURCE_EXHAUSTED, 'Too many media legs');
              return;
            }
            leg = {
              index: legs.size + 1,
              role: audio.role,
              frames: 0,
              bytes: 0,
            };
            legs.set(key, leg);
          }
          conversationId = frame.conversation_id;
          if (metadataOnly) {
            leg.metadata = {
              customer_org_id: frame.customer_org_id,
              encoding: audio.encoding,
              sample_rate_hertz: audio.sample_rate_hertz,
            };
            log({
              event: 'stream_metadata',
              stream_id: streamId,
              leg: leg.index,
              role: leg.role,
              encoding: audio.encoding,
              sample_rate_hertz: audio.sample_rate_hertz,
            });
            return;
          }
          if (
            queue.length >= limits.maxQueuedFrames ||
            queueBytes + audio.audio_data.length > limits.maxQueueBytes
          ) {
            stop(
              grpc.status.RESOURCE_EXHAUSTED,
              'Audio processor cannot keep up',
            );
            return;
          }
          queueBytes += audio.audio_data.length;
          queue.push(frame);
          void drain();
        });
      })();
    },
  });

  const port = await new Promise((resolve, reject) =>
    server.bindAsync(address, credentials, (error, boundPort) =>
      error ? reject(error) : resolve(boundPort),
    ),
  );

  return {
    port,
    close: () =>
      new Promise((resolve) => {
        draining = true;
        const timer = setTimeout(() => server.forceShutdown(), 5000);
        timer.unref();
        server.tryShutdown(async () => {
          clearTimeout(timer);
          await Promise.allSettled([...pending]);
          resolve();
        });
      }),
  };
}
