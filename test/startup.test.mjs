import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:tls';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ConversationAudio, Health, grpc } from '../lib/protocol.mjs';
import { streamFrames, syntheticFrames } from '../support/synthetic.mjs';

test(
  'real entry point serves verified TLS, rejects TLS 1.2 and unauthenticated media, and shuts down',
  { timeout: 15_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'media-forking-test-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const keyFile = join(directory, 'key.pem');
    const certFile = join(directory, 'cert.pem');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1',
        '-keyout',
        keyFile,
        '-out',
        certFile,
      ],
      { stdio: 'ignore' },
    );

    const reservation = createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    const child = spawn(process.execPath, ['--tls-min-v1.3', 'server.mjs'], {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      env: {
        ...process.env,
        PORT: String(port),
        TLS_CERT_FILE: certFile,
        TLS_KEY_FILE: keyFile,
        DATASOURCE_URL: 'https://localhost',
        JWS_ISSUERS: 'https://identity.example/idb',
        JWS_AUDIENCE: 'synthetic',
        JWS_SUBJECT: 'synthetic',
        CUSTOMER_ORG_ID: 'synthetic-org',
        RECORDING_DIR: join(directory, 'recordings'),
        MEDIA_FORKING_SCHEMA_ID: 'synthetic-schema',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    t.after(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    });
    const [output] = await once(child.stdout, 'data', {
      signal: AbortSignal.timeout(5000),
    });
    assert.match(output.toString(), /receiver_listening/, stderr);
    assert.equal(
      (await stat(join(directory, 'recordings'))).mode & 0o777,
      0o700,
    );
    const certificate = await readFile(certFile);
    const address = `localhost:${port}`;
    const health = new Health(
      address,
      grpc.credentials.createSsl(certificate),
      { 'grpc.default_authority': 'localhost' },
    );
    const audio = new ConversationAudio(
      address,
      grpc.credentials.createSsl(certificate),
      { 'grpc.default_authority': 'localhost' },
    );
    t.after(() => {
      audio.close();
      health.close();
    });
    const status = await new Promise((resolve, reject) =>
      health.check({}, { deadline: Date.now() + 3000 }, (error, value) =>
        error ? reject(error) : resolve(value),
      ),
    );
    assert.equal(status.status, 'SERVING');
    await assert.rejects(
      streamFrames(
        audio,
        new grpc.Metadata(),
        syntheticFrames('synthetic-org'),
      ),
      { code: grpc.status.UNAUTHENTICATED },
    );
    await assert.rejects(
      new Promise((resolve, reject) => {
        const socket = connect({
          host: '127.0.0.1',
          port,
          ca: certificate,
          servername: 'localhost',
          maxVersion: 'TLSv1.2',
          ALPNProtocols: ['h2'],
        });
        socket.setTimeout(3000, () =>
          socket.destroy(new Error('TLS handshake timeout')),
        );
        socket.once('error', reject);
        socket.once('secureConnect', () => {
          socket.destroy();
          resolve();
        });
      }),
    );
    audio.close();
    health.close();
    const exited = once(child, 'exit', { signal: AbortSignal.timeout(7000) });
    child.kill('SIGTERM');
    assert.deepEqual(await exited, [0, null], stderr);
  },
);
