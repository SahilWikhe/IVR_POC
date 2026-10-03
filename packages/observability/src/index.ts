export {
  createVoiceTranscriptRecorder,
  type VoiceTranscriptEvent,
  type VoiceTranscriptSink,
} from './voice-transcript.js';

/** Allowlisted operational events: never pass request bodies, headers, or caller data. */
export interface OperationalEvent {
  event: string;
  requestId?: string;
  code?: string;
  count?: number;
}
export function logEvent(event: OperationalEvent): void {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), ...event })}\n`);
}
