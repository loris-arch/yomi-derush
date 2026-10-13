import { spawn } from 'node:child_process';

import { ffmpegPath, ffprobePath } from './env.js';

export class FfmpegError extends Error {}

/** Intervalle silencieux, en secondes absolues dans le fichier. */
export type Silence = {
  readonly startS: number;
  readonly endS: number;
};

export type MediaInfo = {
  readonly durationS: number;
  readonly hasAudio: boolean;
};

type RunResult = { readonly stdout: string; readonly stderr: string };

function run(
  bin: string,
  args: readonly string[],
  onStdoutLine?: (line: string) => void,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let pending = '';

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      if (!onStdoutLine) return;
      pending += text;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) onStdoutLine(line.trim());
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      reject(
        error.code === 'ENOENT'
          ? new FfmpegError(
              `${bin} introuvable. Installe ffmpeg, ou renseigne FFMPEG_PATH et FFPROBE_PATH dans .env.`,
            )
          : error,
      );
    });

    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new FfmpegError(lastLines(stderr, code)));
    });
  });
}

/** ffmpeg est bavard : on ne remonte que la fin de stderr, là où se trouve la cause. */
function lastLines(stderr: string, code: number | null): string {
  const lines = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  const tail = lines.slice(-4).join(' / ');
  return `ffmpeg a échoué (code ${code}) : ${tail === '' ? 'aucune sortie' : tail}`;
}

function parseNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

/** Durée réelle et présence d'une piste audio. Les deux conditionnent la découpe. */
export async function probeMedia(path: string): Promise<MediaInfo> {
  const { stdout } = await run(ffprobePath(), [
    '-v',
    'error',
    '-show_entries',
    'format=duration:stream=codec_type',
    '-of',
    'default=noprint_wrappers=1',
    path,
  ]);

  const lines = stdout.split('\n').map((l) => l.trim());
  const durationLine = lines.find((l) => l.startsWith('duration='));
  const durationS = parseNumber(durationLine?.slice('duration='.length));

  if (durationS === null) {
    throw new FfmpegError(`ffprobe n'a pas renvoyé de durée pour ${path} : fichier illisible ou tronqué.`);
  }

  return {
    durationS,
    hasAudio: lines.includes('codec_type=audio'),
  };
}


const AUDIO_EXTRACT_ARGS = ['-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libopus', '-b:a', '24k'];

/**
 * Extrait la piste audio complète d'un média vers un fichier compressé, prêt à envoyer à l'ASR.
 *
 * Toute la durée, jamais une fenêtre : le diariseur a besoin de l'épisode entier pour regrouper
 * les voix de façon stable. Sur un extrait court il renvoie un locuteur unique — voir le
 * commentaire d'en-tête de `deepgram.ts`.
 */
export async function extractAudio(input: string, output: string): Promise<void> {
  await run(ffmpegPath(), [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-i',
    input,
    ...AUDIO_EXTRACT_ARGS,
    '-map_metadata',
    '-1',
    '-y',
    output,
  ]);
}


export type VideoInfo = {
  readonly durationS: number;
  readonly width: number;
  readonly height: number;
  /** Cadence exacte, en images par seconde : 25, 29,97 (30000/1001), 23,976… */
  readonly fps: number;
  /** 0 quand le fichier n'a pas de piste audio. */
  readonly audioChannels: number;
  readonly sampleRate: number;
};

/**
 * Ce qu'un logiciel de montage doit savoir d'un rush pour le poser dans une séquence : taille,
 * cadence, canaux audio. `probeMedia` ne donne que la durée, suffisante pour couper un clip
 * mais pas pour décrire un fichier à Premiere.
 */
export async function probeVideo(path: string): Promise<VideoInfo> {
  const { stdout } = await run(ffprobePath(), [
    '-v',
    'error',
    '-show_entries',
    'format=duration:stream=codec_type,width,height,r_frame_rate,channels,sample_rate',
    '-of',
    'json',
    path,
  ]);

  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: {
      codec_type?: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
      channels?: number;
      sample_rate?: string;
    }[];
  };

  const durationS = parseNumber(parsed.format?.duration);
  const video = parsed.streams?.find((s) => s.codec_type === 'video');
  const audio = parsed.streams?.find((s) => s.codec_type === 'audio');
  if (durationS === null || video === undefined) {
    throw new FfmpegError(`ffprobe ne trouve ni durée ni piste vidéo dans ${path}.`);
  }

  const [num, den] = (video.r_frame_rate ?? '25/1').split('/').map(Number);
  const fps = num !== undefined && den !== undefined && den > 0 ? num / den : 25;

  return {
    durationS,
    width: video.width ?? 1920,
    height: video.height ?? 1080,
    fps,
    audioChannels: audio?.channels ?? 0,
    sampleRate: parseNumber(audio?.sample_rate) ?? 48000,
  };
}


/**
 * Seuil voix / silence : le creux de l'histogramme des niveaux entre le mode « silence » et le
 * mode « parole ».
 *
 * La règle « 30 % du chemin entre plancher et parole » tenait sur un son de caméra (plancher
 * −45 dB, parole −29 : seuil −40, au creux). Sur un enregistreur propre (plancher −75, parole
 * −40) elle donnait −64, sur la pente du creux côté souffle : une respiration à −60 passait pour
 * de la voix, et 195 bornes sur 490 se retrouvaient « sans silence » au lieu de 114. Le creux,
 * lui, est à −59 sur ce fichier et à −40 sur l'autre : c'est la bonne définition dans les deux
 * cas. Repli sur l'ancienne règle quand l'histogramme n'a pas deux bosses nettes.
 */
function valleyThreshold(levels: readonly number[], floor: number, speech: number): number {
  const fallback = floor + (speech - floor) * 0.3;
  const lo = Math.floor(floor);
  const hi = Math.ceil(speech);
  if (hi - lo < 8) return fallback;
  const bins = new Array<number>(hi - lo + 1).fill(0);
  for (const level of levels) {
    const i = Math.round(level) - lo;
    if (i >= 0 && i < bins.length) bins[i] = (bins[i] ?? 0) + 1;
  }
  // Lissage sur 5 dB, puis creux le plus bas strictement entre les deux modes.
  const smooth = bins.map((_, i) => {
    let sum = 0;
    let n = 0;
    for (let k = i - 2; k <= i + 2; k += 1) {
      if (k >= 0 && k < bins.length) {
        sum += bins[k]!;
        n += 1;
      }
    }
    return sum / n;
  });
  const floorPeak = smooth.indexOf(Math.max(...smooth.slice(0, Math.floor(smooth.length / 2))));
  const speechPeak =
    Math.floor(smooth.length / 2) + smooth.slice(Math.floor(smooth.length / 2)).indexOf(Math.max(...smooth.slice(Math.floor(smooth.length / 2))));
  if (speechPeak - floorPeak < 6) return fallback;
  let valley = floorPeak;
  for (let i = floorPeak; i <= speechPeak; i += 1) if (smooth[i]! < smooth[valley]!) valley = i;
  if (valley === floorPeak || valley === speechPeak) return fallback;
  return lo + valley;
}

/**
 * Silences mesurés en énergie (RMS), avec un seuil adapté au fichier.
 *
 * `silencedetect` compare chaque échantillon à un seuil fixe : c'est un détecteur de crête. Sur
 * un plateau avec un souffle de climatisation, les crêtes du fond de bruit tiennent à −31 dB
 * et le filtre bascule d'un coup — 447 silences à −30 dB, zéro à −32 dB sur 5 min de C0055.
 * Ici on moyenne sur 10 ms, et le seuil est posé entre le plancher du fichier (5ᵉ centile) et
 * le niveau de parole (80ᵉ centile), à 30 % du chemin : la respiration passe sous le seuil,
 * une consonne douce reste au-dessus, quel que soit le micro.
 */
export type EnergyProfile = {
  /** Niveau RMS en dB par fenêtre de `windowS`, du début à la fin du fichier. */
  readonly levels: readonly number[];
  readonly windowS: number;
  /** Plancher de bruit (5ᵉ centile) et niveau de parole (80ᵉ centile) du fichier. */
  readonly floorDb: number;
  readonly speechDb: number;
  /** Seuil voix / silence retenu pour ce fichier : 30 % du chemin entre les deux. */
  readonly thresholdDb: number;
  readonly silences: readonly Silence[];
};

export async function detectSilencesByEnergy(path: string, minSilenceS: number): Promise<readonly Silence[]> {
  return (await analyzeEnergy(path, minSilenceS)).silences;
}

export async function analyzeEnergy(path: string, minSilenceS: number): Promise<EnergyProfile> {
  const rate = 16_000;
  const windowS = 0.01;
  const windowSamples = rate * windowS;

  const levels: number[] = [];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      ffmpegPath(),
      ['-hide_banner', '-nostdin', '-loglevel', 'error', '-i', path, '-vn', '-ac', '1', '-ar', String(rate), '-f', 's16le', '-'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let carry: Buffer = Buffer.alloc(0);
    let sum = 0;
    let count = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      const buffer = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
      const usable = buffer.length - (buffer.length % 2);
      for (let i = 0; i < usable; i += 2) {
        const sample = buffer.readInt16LE(i) / 32768;
        sum += sample * sample;
        count += 1;
        if (count === windowSamples) {
          levels.push(10 * Math.log10(sum / count + 1e-12));
          sum = 0;
          count = 0;
        }
      }
      carry = buffer.subarray(usable);
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new FfmpegError(lastLines(stderr, code)))));
  });

  if (levels.length === 0) return { levels, windowS, floorDb: -90, speechDb: -30, thresholdDb: -60, silences: [] };
  const sorted = [...levels].sort((a, b) => a - b);
  const percentile = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
  const floor = percentile(0.05);
  const speech = percentile(0.8);
  const threshold = valleyThreshold(levels, floor, speech);

  const silences: Silence[] = [];
  let openedAt: number | null = null;
  levels.forEach((level, i) => {
    const t = i * windowS;
    if (level < threshold) {
      if (openedAt === null) openedAt = t;
    } else if (openedAt !== null) {
      if (t - openedAt >= minSilenceS) silences.push({ startS: openedAt, endS: t });
      openedAt = null;
    }
  });
  if (openedAt !== null) silences.push({ startS: openedAt, endS: levels.length * windowS });
  return { levels, windowS, floorDb: floor, speechDb: speech, thresholdDb: threshold, silences };
}
