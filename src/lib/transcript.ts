/** Un mot horodaté, tel que l'ASR le rend. `speaker` vaut 0 sur un tournage face caméra. */
export type TranscriptWord = { w: string; start: number; end: number; speaker: number };

export type TranscriptSource = 'deepgram' | 'whisper-local';

export type Transcript = { words: TranscriptWord[]; text: string; source: TranscriptSource };
