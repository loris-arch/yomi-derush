import { spawn } from 'node:child_process';

import { ffmpegPath } from './env.js';

/**
 * Synchronisation d'un enregistrement audio séparé (enregistreur, micro) sur le son d'une caméra.
 *
 * Deux horloges, deux départs : l'enregistreur démarre quand on veut, et sa base de temps dévie
 * de quelques dizaines de ppm par rapport à la caméra — 120 ms sur une heure, mesuré sur C0055,
 * de quoi désynchroniser les lèvres en fin de rush si l'on ne corrige qu'un décalage fixe.
 *
 * Mesure par corrélation d'enveloppes d'énergie (pas des formes d'onde : deux micros différents
 * n'ont pas la même phase, mais ils entendent les mêmes syllabes). Deux étages pour tenir en
 * temps raisonnable sans FFT : grossier à 10 Hz sur ±5 min, fin à 100 Hz autour du résultat.
 * La dérive vient de la même mesure refaite sur trois fenêtres le long du rush.
 */

export type SyncResult = {
  /** Décalage au début : `ext_t = cam_t × (1 + drift) + offsetS`. */
  readonly offsetS: number;
  /** Dérive relative de l'horloge de l'enregistreur (3,6e-5 = 36 ppm). */
  readonly drift: number;
  /** Corrélation normalisée au point retenu, 0–1. En dessous de 0,3, ce n'est pas le même son. */
  readonly correlation: number;
};

const RATE = 16_000;

function decodeMono16k(path: string): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffmpegPath(),
      ['-hide_banner', '-nostdin', '-loglevel', 'error', '-i', path, '-vn', '-ac', '1', '-ar', String(RATE), '-f', 's16le', '-'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const chunks: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg a échoué sur ${path} : ${stderr.trim().split('\n').slice(-2).join(' / ')}`));
        return;
      }
      const buf = Buffer.concat(chunks);
      const n = Math.floor(buf.length / 2);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i += 1) out[i] = buf.readInt16LE(i * 2) / 32768;
      resolve(out);
    });
  });
}

/** Enveloppe log-énergie à `hz` points par seconde, centrée. */
function envelope(samples: Float32Array, hz: number): Float32Array {
  const win = Math.floor(RATE / hz);
  const n = Math.floor(samples.length / win);
  const out = new Float32Array(n);
  let mean = 0;
  for (let i = 0; i < n; i += 1) {
    let sum = 0;
    for (let k = 0; k < win; k += 1) {
      const v = samples[i * win + k] ?? 0;
      sum += v * v;
    }
    out[i] = Math.log10(sum / win + 1e-9);
    mean += out[i]!;
  }
  mean /= Math.max(1, n);
  for (let i = 0; i < n; i += 1) out[i] = out[i]! - mean;
  return out;
}

/** Meilleur décalage (en points) de `ref` par rapport à `seg`, cherché dans [minLag, maxLag]. */
function bestLag(seg: Float32Array, ref: Float32Array, minLag: number, maxLag: number): { lag: number; score: number } {
  let best = { lag: 0, score: -Infinity };
  const segEnergy = Math.sqrt(seg.reduce((s, v) => s + v * v, 0));
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let dot = 0;
    let refEnergy = 0;
    for (let i = 0; i < seg.length; i += 1) {
      const r = ref[i + lag];
      if (r === undefined) continue;
      dot += seg[i]! * r;
      refEnergy += r * r;
    }
    const score = dot / (segEnergy * Math.sqrt(refEnergy) + 1e-9);
    if (score > best.score) best = { lag, score };
  }
  return best;
}

/**
 * Décalage de `ext` par rapport à `cam` mesuré sur une fenêtre de `cam` commençant à `fromS`.
 * Renvoie `ext_t − cam_t` au milieu de la fenêtre, et la corrélation.
 */
function measureAt(
  camEnv10: Float32Array,
  extEnv10: Float32Array,
  camEnv100: Float32Array,
  extEnv100: Float32Array,
  fromS: number,
  windowS: number,
  searchS: number,
  hint: number | null,
): { offsetS: number; score: number } | null {
  const seg10 = camEnv10.subarray(fromS * 10, (fromS + windowS) * 10);
  if (seg10.length < windowS * 10 * 0.9) return null;
  // Étage grossier : lag en points à 10 Hz, autour de l'indice si on en a un.
  const centre = hint === null ? fromS * 10 : Math.round((fromS + hint) * 10);
  const span = hint === null ? searchS * 10 : 30 * 10;
  const coarse = bestLag(seg10, extEnv10, centre - span, centre + span);
  // Étage fin : ±1 s à 100 Hz autour du résultat.
  const seg100 = camEnv100.subarray(fromS * 100, (fromS + windowS) * 100);
  const fine = bestLag(seg100, extEnv100, coarse.lag * 10 - 100, coarse.lag * 10 + 100);
  return { offsetS: fine.lag / 100 - fromS, score: fine.score };
}

export async function measureSync(camPath: string, extPath: string): Promise<SyncResult> {
  const [cam, ext] = await Promise.all([decodeMono16k(camPath), decodeMono16k(extPath)]);
  const camEnv10 = envelope(cam, 10);
  const extEnv10 = envelope(ext, 10);
  const camEnv100 = envelope(cam, 100);
  const extEnv100 = envelope(ext, 100);
  const camS = cam.length / RATE;

  // Trois fenêtres de 3 min : début, milieu, fin — assez pour une droite.
  const windowS = Math.min(180, Math.floor(camS / 3));
  const anchors = [30, Math.floor(camS / 2) - windowS / 2, Math.floor(camS - windowS - 30)].filter((t) => t >= 0);
  const points: { t: number; offsetS: number; score: number }[] = [];
  let hint: number | null = null;
  for (const t of anchors) {
    const m = measureAt(camEnv10, extEnv10, camEnv100, extEnv100, t, windowS, 300, hint);
    if (m === null) continue;
    points.push({ t: t + windowS / 2, ...m });
    hint = m.offsetS;
  }
  const first = points[0];
  if (first === undefined) throw new Error('Rush trop court pour mesurer la synchronisation.');
  const last = points[points.length - 1]!;
  const drift = points.length >= 2 && last.t !== first.t ? (last.offsetS - first.offsetS) / (last.t - first.t) : 0;
  const offsetS = first.offsetS - drift * first.t;
  const correlation = points.reduce((s, p) => s + p.score, 0) / points.length;
  return { offsetS, drift, correlation };
}

/**
 * Écrit l'enregistrement externe recalé sur la timeline de la caméra : même durée, même origine,
 * dérive corrigée. En aval, ce fichier *est* le son du rush.
 *
 * `ext_t = cam_t × (1 + drift) + offsetS` : on décale l'externe de `offsetS` (silence devant si
 * l'enregistreur a démarré après la caméra, saut dedans sinon), puis on le joue à la vitesse
 * `1 + drift` pour qu'une seconde caméra corresponde à une seconde du fichier conformé.
 */
export async function conformAudio(
  extPath: string,
  sync: SyncResult,
  camDurationS: number,
  outPath: string,
): Promise<void> {
  const filters: string[] = [];
  const seek: string[] = [];
  if (sync.offsetS < 0) filters.push(`adelay=${Math.round(-sync.offsetS * 1000)}:all=1`);
  else seek.push('-ss', sync.offsetS.toFixed(3));
  const tempo = 1 + sync.drift;
  if (Math.abs(sync.drift) > 1e-7) filters.push(`atempo=${tempo.toFixed(8)}`);
  filters.push('apad');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      ffmpegPath(),
      [
        '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
        ...seek, '-i', extPath,
        '-af', filters.join(','),
        '-t', camDurationS.toFixed(3),
        '-c:a', 'pcm_s24le',
        outPath,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`conformAudio : ${stderr.trim()}`))));
  });
}
