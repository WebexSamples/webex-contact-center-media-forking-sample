// Extend this function to process each validated frame; honor signal when doing async work.
export async function handleAudio(frame, { signal }) {
  signal.throwIfAborted();
  // frame.audio.audio_data is raw mono audio, with encoding/rate/timestamp on frame.audio.
  // Keep caller and agent legs separate using conversation_id, audio.role, and audio.role_id.
}
