import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const loaded = config({ path: `${repoRoot}.env` });
// Une variable exportée à vide par le shell n'est pas une valeur : on prend celle du .env.
for (const [name, value] of Object.entries(loaded.parsed ?? {})) {
  if (process.env[name] === '') process.env[name] = value;
}

function optional(name: string): string | null {
  const value = process.env[name];
  return value === undefined || value === '' ? null : value;
}

export const REPO_ROOT = repoRoot;

export function deepgramApiKey(): string | null {
  return optional('DEEPGRAM_API_KEY');
}

export function ffmpegPath(): string {
  return optional('FFMPEG_PATH') ?? 'ffmpeg';
}

export function ffprobePath(): string {
  return optional('FFPROBE_PATH') ?? 'ffprobe';
}
