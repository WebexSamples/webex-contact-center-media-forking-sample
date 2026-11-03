import grpc from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../proto/', import.meta.url));
const definition = loadSync(
  [
    root + 'com/cisco/wcc/ccai/media/v1/conversationaudioforking.proto',
    root + 'com/cisco/wcc/ccai/v1/health.proto',
  ],
  {
    includeDirs: [root],
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
  },
);
const ccai = grpc.loadPackageDefinition(definition).com.cisco.wcc.ccai;

export const ConversationAudio = ccai.media.v1.ConversationAudio;
export const Health = ccai.v1.Health;
export { grpc };
