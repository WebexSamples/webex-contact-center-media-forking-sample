import { mkdir, open, rename, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export async function prepareRecordingDirectory(directory) {
  const path = resolve(directory);
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await stat(path);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0) {
    throw new Error('RECORDING_DIR must be a private directory (mode 0700)');
  }
  return path;
}

function header(encoding, rate, bytes) {
  const pcm = encoding === 'LINEAR16';
  const align = pcm ? 2 : 1;
  const result = Buffer.alloc(pcm ? 44 : 58);
  result.write('RIFF');
  result.writeUInt32LE(result.length - 8 + bytes + (bytes % 2), 4);
  result.write('WAVEfmt ', 8);
  result.writeUInt32LE(pcm ? 16 : 18, 16);
  result.writeUInt16LE(pcm ? 1 : encoding === 'MULAW' ? 7 : 6, 20);
  result.writeUInt16LE(1, 22);
  result.writeUInt32LE(rate, 24);
  result.writeUInt32LE(rate * align, 28);
  result.writeUInt16LE(align, 32);
  result.writeUInt16LE(pcm ? 16 : 8, 34);
  if (!pcm) {
    result.write('fact', 38);
    result.writeUInt32LE(4, 42);
    result.writeUInt32LE(bytes, 46);
  }
  result.write('data', result.length - 8);
  result.writeUInt32LE(bytes, result.length - 4);
  return result;
}

// One instance per RPC: reconnects and participant legs never share a file.
export function createWavRecorder(directory, streamId, log) {
  const legs = new Map();

  async function closeFile(file) {
    if (!file.handle) return;
    try {
      if (file.failed) throw new Error('Recording write failed');
      if (file.encoding === 'LINEAR16' && file.bytes % 2) {
        throw new Error('Incomplete LINEAR16 sample');
      }
      if (file.bytes % 2) await file.handle.writeFile(Buffer.alloc(1));
      const data = header(file.encoding, file.rate, file.bytes);
      let offset = 0;
      while (offset < data.length) {
        const { bytesWritten } = await file.handle.write(
          data,
          offset,
          data.length - offset,
          offset,
        );
        if (!bytesWritten) throw new Error('Recording header write failed');
        offset += bytesWritten;
      }
      await file.handle.sync();
    } catch (error) {
      file.failed = true;
      throw error;
    } finally {
      await file.handle.close();
      file.handle = null;
    }
    await rename(
      join(directory, `${file.name}.partial`),
      join(directory, file.name),
    );
    log({
      event: 'recording_saved',
      stream_id: streamId,
      leg: file.leg,
      role: file.role,
      segment: file.segment,
      file: file.name,
      encoding: file.encoding,
      sample_rate_hertz: file.rate,
      bytes: file.bytes,
    });
  }

  return {
    async write(frame, { signal }) {
      signal.throwIfAborted();
      const audio = frame.audio;
      const key = JSON.stringify([audio.role, audio.role_id]);
      let file = legs.get(key);
      if (
        !file ||
        file.encoding !== audio.encoding ||
        file.rate !== audio.sample_rate_hertz
      ) {
        if (file) await closeFile(file);
        const segment = (file?.segment || 0) + 1;
        // Bound file creation even if a sender repeatedly changes format.
        if (segment > 32) throw new Error('Too many recording segments');
        const leg = file?.leg || legs.size + 1;
        const name = `${streamId}_${leg}_${audio.role}_${segment}.wav`;
        file = {
          name,
          leg,
          segment,
          role: audio.role,
          encoding: audio.encoding,
          rate: audio.sample_rate_hertz,
          bytes: 0,
          handle: null,
          failed: false,
        };
        legs.set(key, file);
        file.handle = await open(
          join(directory, `${name}.partial`),
          'wx',
          0o600,
        );
        try {
          await file.handle.writeFile(header(file.encoding, file.rate, 0));
        } catch (error) {
          file.failed = true;
          throw error;
        }
      }
      signal.throwIfAborted();
      // RIFF uses unsigned 32-bit sizes; never wrap a large recording's header.
      if (file.bytes + audio.audio_data.length > 0xffffffff - 58) {
        file.failed = true;
        throw new Error('WAV size limit reached');
      }
      try {
        await file.handle.writeFile(audio.audio_data);
        file.bytes += audio.audio_data.length;
      } catch (error) {
        file.failed = true;
        throw error;
      }
    },
    async close() {
      const results = await Promise.allSettled(
        [...legs.values()].map(closeFile),
      );
      const failure = results.find((result) => result.status === 'rejected');
      if (failure) throw failure.reason;
    },
  };
}
