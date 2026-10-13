import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { z } from 'zod';

import { asrClient } from '../lib/deepgram.js';
import {
  DEFAULT_CUT_OPTIONS,
  checkPick,
  formatPhrases,
  joinWords,
  pickToCuts,
  resolveRange,
  rushLetter,
  splitPhrases,
  type Cut,
  type CutOptions,
  type Phrase,
  type Pick,
} from '../lib/derush.js';
import { REPO_ROOT } from '../lib/env.js';
import { conformAudio, measureSync } from '../lib/audio-sync.js';
import { analyzeEnergy, extractAudio, probeMedia, probeVideo, type EnergyProfile, type VideoInfo } from '../lib/ffmpeg.js';
import { startJob } from '../lib/log.js';
import type { Transcript } from '../lib/transcript.js';
import {
  buildXmeml,
  type MediaFile,
  type Sequence,
  type SequenceClip,
  type SequenceMarker,
} from '../lib/xmeml.js';

/**
 * Dérush d'un tournage long, livré en séquence Premiere Pro.
 *
 * Le rush est transcrit au mot près et découpé en phrases numérotées ; Claude Code (dans la
 * session du monteur, via le skill `/derush`) choisit les prises et écrit `decision.json` ; le
 * code convertit ces choix en coupes posées sur le son et écrit un XML que Premiere importe
 * directement (Fichier > Importer).
 *
 * Deux passes, toujours :
 *   - `--prepare` : synchro du son séparé, transcription, silences, puis `a-trancher.md` (la
 *     consigne + le transcript numéroté) ;
 *   - `--reuse`   : lit `decision.json`, pose les coupes, écrit `derush.xml`, `rapport.md`,
 *     `cuts.json`. Rejouable à volonté pour essayer d'autres marges.
 *
 * Rien n'est supprimé, les rushes restent en place et ne sont que référencés. Chaque transcript
 * est gardé dans `<sortie>/transcripts/` : on ne paie Deepgram qu'une fois par rush.
 */

const USAGE = `
Usage : pnpm derush <rush|dossier>... [options]

Les rushes sont pris dans l'ordre donné ; un dossier apporte ses vidéos par ordre alphabétique.

Options
  --script <fichier>   Le script prévu (texte ou markdown) : ordre du discours et passages manquants
  --audio <fichier>    Enregistrement audio séparé (enregistreur, micro) : synchronisé par corrélation sur
                       le son de la caméra, dérive corrigée, puis utilisé pour tout (coupes, transcription,
                       pistes audio du XML). Un seul rush dans ce cas.
  --out <dossier>      Dossier de sortie (défaut : <dossier du premier rush>/derush)
  --name <nom>         Nom de la séquence (défaut : nom du dossier des rushes)
  --pad-start <s>      Marge avant le premier mot d'une coupe (défaut ${DEFAULT_CUT_OPTIONS.padStartS})
  --pad-end <s>        Marge après le dernier mot (défaut ${DEFAULT_CUT_OPTIONS.padEndS})
  --max-gap <s>        Pause mesurée dans le son, à l'intérieur d'une prise, ramenée à ${DEFAULT_CUT_OPTIONS.gapKeepS} s au-delà de cette durée (défaut ${DEFAULT_CUT_OPTIONS.maxGapS}, 0 = jamais)
  --asr <moteur>       deepgram (défaut, DEEPGRAM_API_KEY, garde les reprises) ou whisper (local,
                       gratuit, mais efface les reprises : à éviter pour un dérush)
  --prepare            Synchro, transcription, silences, puis a-trancher.md : la consigne et le
                       transcript numéroté, que Claude Code lit pour écrire decision.json
  --reuse              Lit decision.json et fabrique derush.xml, rapport.md, cuts.json
  --retranscribe       Refait la synchro et les transcripts même s'ils existent

Sortie : derush.xml (à importer dans Premiere), rapport.md, cuts.json, audio/, transcripts/.
`.trim();

const VIDEO_EXT = new Set(['.mp4', '.mov', '.mxf', '.m4v', '.mts', '.avi', '.mkv']);

class ExitSignal extends Error {}

function fail(message: string): never {
  console.error(`\n✖ ${message}\n`);
  process.exitCode = 1;
  throw new ExitSignal();
}

const decisionSchema = z.object({
  keep: z.array(
    z.object({
      first: z.string(),
      last: z.string(),
      why: z.string(),
      from: z.string().optional(),
      to: z.string().optional(),
      alternates: z.array(
        z.object({
          first: z.string(),
          last: z.string(),
          from: z.string().optional(),
          to: z.string().optional(),
        }),
      ),
    }),
  ),
  warnings: z.array(z.object({ at: z.string(), text: z.string() })),
  missing: z.array(z.string()),
});

type Decision = z.infer<typeof decisionSchema>;

type Rush = {
  readonly path: string;
  readonly info: VideoInfo;
  /** Le fichier qui porte le son : la vidéo, ou l'enregistrement séparé conformé sur sa timeline. */
  readonly audioPath: string;
  /** Rang du média audio dans la liste des médias du XML, quand il est séparé. */
  readonly audioMedia?: number | undefined;
  readonly transcript: Transcript;
  readonly phrases: readonly Phrase[];
  /** Énergie et silences mesurés sur tout le rush : c'est là-dessus que les coupes se posent. */
  readonly energy: EnergyProfile;
};

/**
 * Durée minimale d'un silence qui peut servir de point de coupe. En dessous, c'est un creux
 * entre deux syllabes, pas une respiration. Le seuil de niveau, lui, s'adapte au fichier — voir
 * `detectSilencesByEnergy`.
 */
const SILENCE_MIN_S = 0.12;

async function expandRushes(inputs: readonly string[]): Promise<string[]> {
  const files: string[] = [];
  for (const input of inputs) {
    const path = resolve(input);
    const info = await stat(path).catch(() => null);
    if (info === null) fail(`${path} n'existe pas.`);
    if (info.isDirectory()) {
      const entries = (await readdir(path))
        .filter((name) => !name.startsWith('.') && VIDEO_EXT.has(extname(name).toLowerCase()))
        .sort((a, b) => a.localeCompare(b, 'fr', { numeric: true }));
      files.push(...entries.map((name) => join(path, name)));
    } else {
      files.push(path);
    }
  }
  return files;
}

function seconds(raw: string | undefined, fallback: number, flag: string): number {
  if (raw === undefined) return fallback;
  const value = Number(raw.replace(',', '.'));
  if (!Number.isFinite(value) || value < 0) fail(`--${flag} attend un nombre positif, reçu « ${raw} ».`);
  return value;
}

function clock(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

const WHISPER_PYTHON = join(REPO_ROOT, '.whisper/bin/python');
const WHISPER_SCRIPT = join(REPO_ROOT, 'scripts/whisper-words.py');
const PROMPT_PATH = join(REPO_ROOT, 'prompts/derush.md');

const whisperOutput = z.object({
  words: z.array(z.object({ w: z.string(), start: z.number(), end: z.number(), speaker: z.number() })),
  durationS: z.number(),
});

/** Whisper en local. Lit la vidéo directement : pas d'extraction audio à faire avant. */
function whisper(path: string): Promise<Transcript> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(WHISPER_PYTHON, [WHISPER_SCRIPT, path], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', (error: NodeJS.ErrnoException) =>
      reject(
        error.code === 'ENOENT'
          ? new Error(
              `Whisper n'est pas installé. Une fois pour toutes : python3 -m venv .whisper ` +
                `&& .whisper/bin/pip install mlx-whisper`,
            )
          : error,
      ),
    );
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Whisper a échoué (code ${code}) : ${stderr.trim().split('\n').slice(-3).join(' / ')}`));
        return;
      }
      const { words } = whisperOutput.parse(JSON.parse(stdout));
      resolvePromise({ words, text: words.map((w) => w.w).join(' '), source: 'whisper-local' });
    });
  });
}

/** Transcrit un rush, ou relit son transcript s'il a déjà été fait une fois. */
async function transcriptOf(
  path: string,
  info: VideoInfo,
  cacheDir: string,
  force: boolean,
  asr: 'whisper' | 'deepgram',
  audioPath: string,
): Promise<Transcript> {
  // Un transcript du son caméra et un du son séparé ne sont pas le même transcript.
  const cachePath = join(cacheDir, `${basename(path)}${audioPath === path ? '' : '.sync'}.json`);
  if (!force) {
    const cached = await readFile(cachePath, 'utf8').catch(() => null);
    if (cached !== null) return JSON.parse(cached) as Transcript;
  }

  if (info.audioChannels === 0) fail(`${basename(path)} n'a pas de piste audio : rien à transcrire.`);

  if (asr === 'whisper') {
    const transcript = await whisper(audioPath);
    if (transcript.words.length === 0) fail(`Whisper n'a entendu aucun mot dans ${basename(path)}.`);
    await writeFile(cachePath, JSON.stringify(transcript));
    return transcript;
  }

  const workDir = await mkdtemp(join(tmpdir(), 'derush-'));
  try {
    const compressed = join(workDir, 'audio.ogg');
    await extractAudio(audioPath, compressed);
    const result = await asrClient().transcribe({
      subject: `derush-${basename(path, extname(path))}`,
      audioPath: compressed,
    });
    // Même recoupement que le job `transcribe` : un audio tronqué donnerait un dérush partiel.
    if (result.durationS / info.durationS < 0.95) {
      fail(
        `Transcript tronqué pour ${basename(path)} : ${result.durationS.toFixed(0)} s traitées ` +
          `sur ${info.durationS.toFixed(0)} s.`,
      );
    }
    await writeFile(cachePath, JSON.stringify(result.transcript));
    return result.transcript;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * Les numéros cités par la décision existent-ils, chaque plage tient-elle dans un rush, et ses
 * citations `from` / `to` s'y trouvent-elles ?
 */
function checkDecision(
  decision: Decision,
  byId: ReadonlyMap<string, Phrase>,
  rushes: readonly Rush[],
): string[] {
  const wordsOf = (pick: Pick) => {
    const phrase = byId.get(pick.first);
    return phrase === undefined ? undefined : rushes[phrase.rush]?.transcript.words;
  };
  const problems: string[] = [];
  decision.keep.forEach((item, i) => {
    const own = checkPick(item, byId, wordsOf(item));
    if (own !== null) problems.push(`keep[${i}] : ${own}`);
    item.alternates.forEach((alt, k) => {
      const problem = checkPick(alt, byId, wordsOf(alt));
      if (problem !== null) problems.push(`keep[${i}].alternates[${k}] : ${problem}`);
    });
  });
  return problems;
}

/** Ce que lit celui qui tranche : Claude Code, dans la session du monteur. */
function derushContext(rushes: readonly Rush[], script: string | null): string {
  const legend = rushes
    .map((r, i) => `Rush ${rushLetter(i)} : ${basename(r.path)} (${clock(r.info.durationS)})`)
    .join('\n');
  return (
    (script === null ? 'Pas de script fourni.\n\n' : `# Script prévu\n\n${script}\n\n`) +
    `# Rushes\n\n${legend}\n\n# Transcription, une phrase par ligne\n\n` +
    rushes.map((r) => formatPhrases(r.phrases)).join('\n\n')
  );
}

/** Le format de `decision.json`, rappelé en tête de `a-trancher.md`. */
const DECISION_FORMAT = `
# Format de la réponse

Écrire \`decision.json\` dans ce dossier, puis relancer la commande avec \`--reuse\` :

\`\`\`json
{
  "keep": [
    { "first": "A12", "last": "A15", "why": "", "alternates": [{ "first": "A4", "last": "A7" }] },
    { "first": "A20", "last": "A20", "from": "vous pouvez postuler aux centaines", "to": "en France aujourd'hui", "why": "reprise sans pause dans la phrase", "alternates": [] }
  ],
  "warnings": [{ "at": "A40", "text": "aucune prise propre de ce passage" }],
  "missing": []
}
\`\`\`
`.trim();

function excerpt(text: string, words = 8): string {
  const parts = text.split(/\s+/);
  return parts.length <= words ? text : `${parts.slice(0, words).join(' ')}…`;
}

function rangeText(pick: Pick, byId: ReadonlyMap<string, Phrase>, rushes: readonly Rush[]): string {
  const first = byId.get(pick.first);
  const words = first === undefined ? undefined : rushes[first.rush]?.transcript.words;
  if (words === undefined) return '';
  const range = resolveRange(pick, byId, words);
  return typeof range === 'string' ? '' : joinWords(words.slice(range.start, range.end + 1));
}

function containing(pick: Pick, id: string, byId: ReadonlyMap<string, Phrase>): boolean {
  const first = byId.get(pick.first);
  const last = byId.get(pick.last);
  const target = byId.get(id);
  if (first === undefined || last === undefined || target === undefined) return false;
  return (
    target.rush === first.rush &&
    target.firstWord >= first.firstWord &&
    target.lastWord <= last.lastWord
  );
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      script: { type: 'string' },
      audio: { type: 'string' },
      out: { type: 'string' },
      name: { type: 'string' },
      'pad-start': { type: 'string' },
      'pad-end': { type: 'string' },
      'max-gap': { type: 'string' },
      reuse: { type: 'boolean', default: false },
      prepare: { type: 'boolean', default: false },
      asr: { type: 'string', default: 'deepgram' },
      retranscribe: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });

  if (values.help || positionals.length === 0) fail(`Aucun rush fourni.\n\n${USAGE}`);

  const paths = await expandRushes(positionals);
  const firstPath = paths[0];
  if (firstPath === undefined) fail(`Aucune vidéo trouvée dans ${positionals.join(', ')}.`);

  const maxGap = seconds(values['max-gap'], DEFAULT_CUT_OPTIONS.maxGapS, 'max-gap');
  const cutOptions: CutOptions = {
    padStartS: seconds(values['pad-start'], DEFAULT_CUT_OPTIONS.padStartS, 'pad-start'),
    padEndS: seconds(values['pad-end'], DEFAULT_CUT_OPTIONS.padEndS, 'pad-end'),
    maxGapS: maxGap === 0 ? Number.POSITIVE_INFINITY : maxGap,
    gapKeepS: DEFAULT_CUT_OPTIONS.gapKeepS,
    snapS: DEFAULT_CUT_OPTIONS.snapS,
    extendS: DEFAULT_CUT_OPTIONS.extendS,
    extendMaxWords: DEFAULT_CUT_OPTIONS.extendMaxWords,
  };

  const asr = values.asr;
  if (asr !== 'whisper' && asr !== 'deepgram') fail(`--asr attend whisper ou deepgram, reçu « ${asr} ».`);
  if (values.prepare === values.reuse) fail(`Il faut exactement l'un de --prepare (préparer) ou --reuse (fabriquer).\n\n${USAGE}`);

  if (values.audio !== undefined && paths.length > 1) fail(`--audio ne s'applique qu'à un seul rush (${paths.length} fournis).`);

  const outDir = resolve(values.out ?? join(dirname(firstPath), 'derush'));
  const name = values.name ?? basename(dirname(firstPath));
  const transcriptsDir = join(outDir, 'transcripts');
  await mkdir(transcriptsDir, { recursive: true });

  const script =
    values.script === undefined ? null : (await readFile(resolve(values.script), 'utf8')).trim();

  const log = startJob('derush', name);

  try {
    console.log(`\nDérush « ${name} » — ${paths.length} rush(es)`);
    const rushes: Rush[] = [];
    for (const [i, path] of paths.entries()) {
      const info = await probeVideo(path);
      let audioPath = path;
      if (values.audio !== undefined) {
        // Son séparé : synchronisé une fois, écrit à côté des transcripts, puis c'est lui le son.
        const external = resolve(values.audio);
        await mkdir(join(outDir, 'audio'), { recursive: true });
        audioPath = join(outDir, 'audio', `${basename(path, extname(path))}.sync.wav`);
        const already = await stat(audioPath).catch(() => null);
        if (already === null || values.retranscribe) {
          console.log(`  … synchronisation de ${basename(external)} sur le son caméra`);
          const sync = await measureSync(path, external);
          if (sync.correlation < 0.3) {
            fail(
              `${basename(external)} ne correspond pas au son de ${basename(path)} ` +
                `(corrélation ${sync.correlation.toFixed(2)}). Mauvais fichier ?`,
            );
          }
          await conformAudio(external, sync, info.durationS, audioPath);
          console.log(
            `  … décalage ${sync.offsetS.toFixed(3)} s, dérive ${(sync.drift * 1e6).toFixed(0)} ppm ` +
              `(${(sync.drift * info.durationS * 1000).toFixed(0)} ms sur le rush), corrélation ${sync.correlation.toFixed(2)}`,
          );
        }
      }
      console.log(`  … ${rushLetter(i)}  ${basename(path)}  ${clock(info.durationS)}  transcription (${asr})`);
      const transcript = await transcriptOf(path, info, transcriptsDir, values.retranscribe, asr, audioPath);
      const energy = await analyzeEnergy(audioPath, SILENCE_MIN_S);
      rushes.push({
        path,
        info,
        audioPath,
        audioMedia: audioPath === path ? undefined : paths.length + i,
        transcript,
        phrases: splitPhrases(transcript.words, i),
        energy,
      });
    }

    const byId = new Map(rushes.flatMap((r) => r.phrases.map((p) => [p.id, p] as const)));
    const decisionPath = join(outDir, 'decision.json');

    if (values.prepare) {
      const prompt = (await readFile(PROMPT_PATH, 'utf8')).trim();
      const questionPath = join(outDir, 'a-trancher.md');
      await writeFile(questionPath, `${prompt}\n\n${DECISION_FORMAT}\n\n---\n\n${derushContext(rushes, script)}\n`);
      log.done('ok', { prepared: questionPath, phrases: byId.size });
      console.log(`\n✔ ${byId.size} phrases prêtes à trancher : ${questionPath}`);
      console.log(`  Une fois decision.json écrit : même commande avec --reuse\n`);
      return;
    }

    const raw = await readFile(decisionPath, 'utf8').catch(() => null);
    if (raw === null) fail(`--reuse : aucune décision dans ${decisionPath}. Lance d'abord --prepare, puis écris decision.json.`);
    const parsed = decisionSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) fail(`decision.json invalide : ${parsed.error.issues.map((i) => `${i.path.join('.')} : ${i.message}`).join(' ; ')}`);
    const decision: Decision = parsed.data;
    const problems = checkDecision(decision, byId, rushes);
    if (problems.length > 0) fail(`decision.json ne correspond pas au transcript : ${problems.join(' ; ')}`);

    const media: MediaFile[] = rushes.map((r) => ({ path: r.path, ...r.info }));
    for (const r of rushes) {
      if (r.audioMedia === undefined) continue;
      const audioInfo = await probeVideo(r.audioPath).catch(async () => {
        const m = await probeMedia(r.audioPath);
        return { durationS: m.durationS, width: 0, height: 0, fps: r.info.fps, audioChannels: 2, sampleRate: 48000 };
      });
      media[r.audioMedia] = { path: r.audioPath, ...audioInfo, width: 0, height: 0, fps: r.info.fps };
    }
    const cutsOf = (pick: Pick): Cut[] => {
      const phrase = byId.get(pick.first);
      const rush = phrase === undefined ? undefined : rushes[phrase.rush];
      if (rush === undefined) return [];
      return pickToCuts(pick, byId, rush.transcript.words, rush.info.durationS, rush.energy.silences, cutOptions, rush.energy);
    };
    const length = (cuts: readonly Cut[]): number => cuts.reduce((n, c) => n + c.outS - c.inS, 0);

    // Séquence 1 : le montage.
    const mainClips: SequenceClip[] = [];
    const mainMarkers: SequenceMarker[] = [];
    const starts: number[] = [];
    let cursor = 0;
    let unsafeCount = 0;
    let extendedCount = 0;
    decision.keep.forEach((item, i) => {
      starts.push(cursor);
      const cuts = cutsOf(item);
      const label = `#${i + 1} ${excerpt(rangeText(item, byId, rushes))}`;
      let at = cursor;
      for (const cut of cuts) {
        mainClips.push({ media: cut.rush, audioMedia: rushes[cut.rush]?.audioMedia, inS: cut.inS, outS: cut.outS, name: label });
        // Des mots en plus pour atteindre un silence : le monteur doit savoir que le texte déborde.
        if (cut.extended[0] > 0 || cut.extended[1] > 0) {
          mainMarkers.push({
            atS: at,
            name: `ETENDU #${i + 1}`,
            comment: `Coupe étendue jusqu'au silence : ${cut.extended[0]} mot(s) avant, ${cut.extended[1]} après.`,
          });
          extendedCount += 1;
        }
        // Une borne sans silence : le monteur doit l'écouter. Marqueur à l'endroit exact.
        if (cut.unsafe.includes('in')) {
          mainMarkers.push({ atS: at, name: `COUPE-VOIX #${i + 1}`, comment: 'Entrée posée sans silence : écouter le raccord.' });
          unsafeCount += 1;
        }
        if (cut.unsafe.includes('out')) {
          mainMarkers.push({ atS: at + cut.outS - cut.inS, name: `COUPE-VOIX #${i + 1}`, comment: 'Sortie posée sans silence : écouter le raccord.' });
          unsafeCount += 1;
        }
        at += cut.outS - cut.inS;
      }
      if (item.alternates.length > 0) {
        mainMarkers.push({
          atS: cursor,
          name: `AUTRE-PRISE #${i + 1} (${item.alternates.length})`,
          comment: item.why,
        });
      }
      cursor += length(cuts);
    });
    for (const warning of decision.warnings) {
      const index = decision.keep.findIndex((item) => containing(item, warning.at, byId));
      const atS = index === -1 ? null : starts[index];
      if (atS === undefined || atS === null) continue;
      mainMarkers.push({ atS, name: `A-VERIFIER #${index + 1}`, comment: warning.text });
    }

    // Séquence 2 : les autres prises, rangées par passage, pour échanger sans fouiller les rushes.
    const altClips: SequenceClip[] = [];
    const altMarkers: SequenceMarker[] = [];
    let altCursor = 0;
    decision.keep.forEach((item, i) => {
      item.alternates.forEach((alt, k) => {
        const cuts = cutsOf(alt);
        altMarkers.push({
          atS: altCursor,
          name: `#${i + 1} prise ${k + 2}`,
          comment: `Remplace #${i + 1} : ${excerpt(rangeText(item, byId, rushes), 14)}`,
        });
        for (const cut of cuts) {
          altClips.push({ media: cut.rush, audioMedia: rushes[cut.rush]?.audioMedia, inS: cut.inS, outS: cut.outS, name: `#${i + 1} alt ${k + 1}` });
        }
        altCursor += length(cuts);
      });
    });

    const sequences: Sequence[] = [
      { name: `${name} — dérush`, clips: mainClips, markers: mainMarkers },
    ];
    if (altClips.length > 0) {
      sequences.push({ name: `${name} — autres prises`, clips: altClips, markers: altMarkers });
    }
    const xmlPath = join(outDir, 'derush.xml');
    await writeFile(xmlPath, buildXmeml(name, media, sequences));
    // La liste des coupes du montage, pour le contrôle (`pnpm check`) et pour relire.
    await writeFile(
      join(outDir, 'cuts.json'),
      JSON.stringify(
        mainClips.map((c) => ({ path: media[c.media]?.path, audio: media[c.audioMedia ?? c.media]?.path, inS: c.inS, outS: c.outS, name: c.name })),
        null,
        1,
      ),
    );

    // Le rapport : ce que le monteur lit avant d'ouvrir la séquence.
    const rushTotal = rushes.reduce((n, r) => n + r.info.durationS, 0);
    const fpsSet = new Set(rushes.map((r) => r.info.fps.toFixed(3)));
    const report = [
      `# Dérush — ${name}`,
      '',
      `Rushes : ${clock(rushTotal)} au total → montage : **${clock(cursor)}** (${decision.keep.length} plages, ${mainClips.length} coupes).`,
      `Importer \`derush.xml\` dans Premiere (Fichier > Importer). Les rushes sont référencés à leur place, rien n'a été copié.`,
      `Coupes posées sur les silences mesurés ; ${unsafeCount} borne(s) sans silence, marquées \`COUPE-VOIX\`. Coupes sèches, sans fondu : c'est voulu.`,
      ...(fpsSet.size > 1
        ? ['', `**Cadences différentes entre les rushes** (${[...fpsSet].join(', ')} i/s) : la séquence prend celle du rush A.`]
        : []),
      '',
      '## Rushes',
      '',
      ...rushes.map(
        (r, i) =>
          `- **${rushLetter(i)}** ${basename(r.path)} — ${clock(r.info.durationS)}, ${r.info.width}×${r.info.height}, ${r.info.fps.toFixed(2)} i/s, ${r.info.audioChannels} canal(aux)`,
      ),
      ...(decision.warnings.length > 0
        ? ['', '## À vérifier', '', ...decision.warnings.map((w) => `- \`${w.at}\` ${w.text}`)]
        : []),
      ...(decision.missing.length > 0
        ? ['', '## Passages du script jamais dits', '', ...decision.missing.map((m) => `- ${m}`)]
        : []),
      '',
      '## Montage',
      '',
      ...decision.keep.map((item, i) => {
        const at = clock(starts[i] ?? 0);
        const alts = item.alternates.length > 0 ? ` — *${item.alternates.length} autre(s) prise(s)*` : '';
        const why = item.why.trim() === '' ? '' : `\n  > ${item.why}`;
        return `${i + 1}. \`${at}\` \`${item.first}–${item.last}\`${alts}\n  ${rangeText(item, byId, rushes)}${why}`;
      }),
      '',
    ].join('\n');
    await writeFile(join(outDir, 'rapport.md'), report);

    log.done('ok', {
      rushes: rushes.length,
      rush_s: Math.round(rushTotal),
      cut_s: Math.round(cursor),
      ranges: decision.keep.length,
      cuts: mainClips.length,
      alternates: altClips.length,
      warnings: decision.warnings.length,
      unsafe_cuts: unsafeCount,
      extended_cuts: extendedCount,
      missing: decision.missing.length,
    });

    console.log(`\n✔ ${clock(rushTotal)} de rushes → ${clock(cursor)} de montage`);
    console.log(`  ${decision.keep.length} plages, ${mainClips.length} coupes, ${altClips.length} prise(s) alternative(s)`);
    if (decision.warnings.length > 0) console.log(`  ${decision.warnings.length} point(s) à vérifier`);
    if (unsafeCount > 0) console.log(`  ${unsafeCount} borne(s) posée(s) sans silence (marqueurs COUPE-VOIX)`);
    if (extendedCount > 0) console.log(`  ${extendedCount} coupe(s) étendue(s) jusqu'à un silence (marqueurs ETENDU)`);
    if (decision.missing.length > 0) console.log(`  ${decision.missing.length} passage(s) du script jamais dit(s)`);
    console.log(`\n  Premiere : Fichier > Importer > ${xmlPath}`);
    console.log(`  Rapport  : ${join(outDir, 'rapport.md')}\n`);
  } catch (error) {
    if (!(error instanceof ExitSignal)) {
      log.done('failed', { reason: error instanceof Error ? error.message : String(error) });
    }
    throw error;
  }
}

try {
  await main();
} catch (error) {
  if (!(error instanceof ExitSignal)) {
    process.exitCode = 1;
    console.error(`\n✖ ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
