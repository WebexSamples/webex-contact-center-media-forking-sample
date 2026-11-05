import { readFile } from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';
import { DEFAULT_MIN_VERSION } from 'node:tls';
import { createVerifier } from './lib/auth.mjs';
import { readConfig } from './lib/config.mjs';
import { grpc } from './lib/protocol.mjs';
import { startReceiver } from './lib/receiver.mjs';
import { prepareRecordingDirectory } from './lib/recording.mjs';

try {
  if (DEFAULT_MIN_VERSION !== 'TLSv1.3') {
    throw new Error('Use npm start to require TLS 1.3');
  }
  const config = readConfig();
  const [cert, key] = await Promise.all([
    readFile(config.certFile),
    readFile(config.keyFile),
  ]);
  const certificate = new X509Certificate(cert);
  if (
    Date.parse(certificate.validFrom) > Date.now() ||
    Date.parse(certificate.validTo) <= Date.now()
  ) {
    throw new Error('TLS certificate is outside its validity period');
  }
  if (!certificate.checkHost(new URL(config.datasourceUrl).hostname)) {
    throw new Error('TLS certificate does not match the data-source hostname');
  }
  const receiver = await startReceiver({
    recordingDirectory: config.recordingDirectory
      ? await prepareRecordingDirectory(config.recordingDirectory)
      : undefined,
    address: `0.0.0.0:${config.port}`,
    credentials: grpc.ServerCredentials.createSsl(null, [
      { private_key: key, cert_chain: cert },
    ]),
    verifyToken: createVerifier(config),
  });
  console.log(
    JSON.stringify({
      event: 'receiver_listening',
      port: receiver.port,
      transport: 'TLS',
    }),
  );
  const shutdown = async () => {
    console.log(JSON.stringify({ event: 'receiver_draining' }));
    await receiver.close();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
} catch (error) {
  console.error('Receiver startup failed:', error.message);
  process.exitCode = 1;
}
