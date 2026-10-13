import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { asrClient } from '../lib/deepgram.js';
import { ffmpegPath } from '../lib/env.js';
import { analyzeEnergy, extractAudio } from '../lib/ffmpeg.js';
import type { Transcript } from '../lib/transcript.js';

/**
 * Contrôle d'un montage fabriqué par `pnpm derush --reuse`.
 *
 * Rend l'audio exact du montage (coupes sèches, comme dans Premiere), le retranscrit, et mesure
 * ce qu'on ne peut pas voir dans le texte des choix : les pauses restantes, les bornes posées en
 * pleine voix, les mots doublés de part et d'autre d'une coupe. Puis imprime le texte du montage
 * coupe par coupe, pour la relecture : c'est là qu'on voit une idée dite deux fois, un début de
 * mot mangé, un bout de phrase voisine qui est rentré.
 *
 * Écrit `controle-audio.m4a` (à écouter) et `controle.md` (les chiffres et le texte).
 */

const USAGE = `
Usage : pnpm check <dossier de sortie du dérush>

Lit cuts.json, écrit controle-audio.m4a et controle.md dans le même dossier.
`.trim();

type Cut = { readonly audio: string; readonly inS: number; readonly outS: number; readonly name: string };

function renderMontage(cuts: readonly Cut[], outPath: string): Promise<void> {
  const source = cuts[0]?.audio;
  if (source === undefined) throw new Error('cuts.json est vide.');
  const parts = cuts.map((c, i) => `[0:a]atrim=${c.inS.toFixed(3)}:${c.outS.toFixed(3)},asetpts=PTS-STARTPTS[s${i}]`);
  const graph = `${parts.join(';')};${cuts.map((_, i) => `[s${i}]`).join('')}concat=n=${cuts.length}:v=0:a=1[out]`;
  return new Promise((res, rej) => {
    const child = spawn(
      ffmpegPath(),
      ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-i', source, '-filter_complex', graph, '-map', '[out]', '-c:a', 'aac', '-b:a', '128k', outPath],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', rej);
    child.on('close', (code) => (code === 0 ? res() : rej(new Error(`rendu du montage : ${stderr.trim()}`))));
  });
}

function clock(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}

function normalize(w: string): string {
  return w.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
}

async function main(): Promise<void> {
  const { positionals } = parseArgs({ allowPositionals: true, options: {} });
  const dir = positionals[0];
  if (dir === undefined) {
    console.error(`\n✖ Aucun dossier fourni.\n\n${USAGE}\n`);
    process.exitCode = 1;
    return;
  }
  const outDir = resolve(dir);
  const cuts = JSON.parse(await readFile(join(outDir, 'cuts.json'), 'utf8')) as Cut[];
  const audioPath = join(outDir, 'controle-audio.m4a');

  console.log(`\nContrôle de ${outDir}`);
  console.log(`  … rendu de l'audio du montage (${cuts.length} coupes)`);
  await renderMontage(cuts, audioPath);

  // Frontières des coupes dans le temps du montage.
  const boundaries: number[] = [];
  let t = 0;
  for (const c of cuts) {
    t += c.outS - c.inS;
    boundaries.push(t);
  }
  const totalS = t;

  console.log(`  … mesure de l'énergie`);
  const energy = await analyzeEnergy(audioPath, 0.12);
  const level = (at: number): number => {
    const i = Math.floor(at / energy.windowS);
    let best = -Infinity;
    for (let k = i - 3; k <= i + 3; k += 1) best = Math.max(best, energy.levels[k] ?? -Infinity);
    return best;
  };
  const loud = energy.speechDb - 6;
  const voicedIn = boundaries.slice(0, -1).filter((b) => level(b) >= loud).length;
  const voicedOut = boundaries.slice(0, -1).filter((b) => level(b - 0.005) >= loud).length;
  const pauses = energy.silences.map((s) => s.endS - s.startS);
  const over = (x: number): number => pauses.filter((p) => p > x).length;
  const longest = [...energy.silences].sort((a, b) => b.endS - b.startS - (a.endS - a.startS)).slice(0, 5);

  console.log(`  … retranscription du montage`);
  const workDir = await mkdtemp(join(tmpdir(), 'derush-check-'));
  let transcript: Transcript;
  try {
    const compressed = join(workDir, 'montage.ogg');
    await extractAudio(audioPath, compressed);
    transcript = (await asrClient().transcribe({ subject: 'controle', audioPath: compressed })).transcript;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }

  // Bigrammes répétés de part et d'autre d'une coupe, dans une fenêtre de 4 s.
  const toks = transcript.words.map((w) => ({ t: normalize(w.w), at: w.start })).filter((x) => x.t !== '');
  const repeats: string[] = [];
  for (let i = 0; i < toks.length - 2; i += 1) {
    const g = `${toks[i]!.t} ${toks[i + 1]!.t}`;
    if (g.replace(' ', '').length < 6) continue;
    for (let j = i + 2; j < Math.min(toks.length - 2, i + 12); j += 1) {
      if (`${toks[j]!.t} ${toks[j + 1]!.t}` !== g || toks[j]!.at - toks[i]!.at >= 4) continue;
      if (boundaries.some((b) => toks[i]!.at < b && b < toks[j]!.at + 0.3)) {
        repeats.push(`${clock(toks[i]!.at)}  ${toks.slice(Math.max(0, i - 2), j + 4).map((x) => x.t).join(' ')}`);
      }
      break;
    }
  }

  // Texte du montage, coupe par coupe.
  const perCut: string[] = [];
  let k = 0;
  let buffer: string[] = [];
  for (const w of transcript.words) {
    while (k < boundaries.length - 1 && w.start >= boundaries[k]!) {
      perCut.push(`[${String(k + 1).padStart(3)}] ${buffer.join(' ')}`);
      buffer = [];
      k += 1;
    }
    buffer.push(w.w);
  }
  perCut.push(`[${String(k + 1).padStart(3)}] ${buffer.join(' ')}`);
  const empties = perCut.filter((line) => line.split(' ').length <= 2).length;

  const lines = [
    `# Contrôle du montage`,
    '',
    `Durée ${clock(totalS)}, ${cuts.length} coupes. Seuil voix/silence ${energy.thresholdDb.toFixed(0)} dB.`,
    '',
    `- Bornes à niveau de parole pleine : **${voicedIn} entrées / ${voicedOut} sorties** sur ${cuts.length - 1}`,
    `- Pauses > 0,35 s : ${over(0.35)} ; > 0,6 s : **${over(0.6)}** ; la plus longue ${(pauses.length > 0 ? Math.max(...pauses) : 0).toFixed(2)} s`,
    ...longest.map((s) => `  - ${(s.endS - s.startS).toFixed(2)} s à ${clock(s.startS)}`),
    `- Coupes dont la retranscription ne contient 0 ou 1 mot : **${empties}** (signe d'un mot coupé ou d'un éclat)`,
    `- Bigrammes répétés à cheval sur une coupe : **${repeats.length}** (vérifier à la main : certains sont voulus)`,
    ...repeats.map((r) => `  - ${r}`),
    '',
    `Écouter : \`controle-audio.m4a\` (coupes sèches, comme dans Premiere).`,
    '',
    `## Texte du montage, coupe par coupe`,
    '',
    ...perCut,
    '',
  ];
  await writeFile(join(outDir, 'controle.md'), lines.join('\n'));
  console.log(lines.slice(2, 12).join('\n'));
  console.log(`\n✔ controle.md et controle-audio.m4a écrits dans ${outDir}\n`);
}

await main();
