import { basename } from 'node:path';

/**
 * Écrit une séquence au format Final Cut Pro 7 XML (`xmeml` version 4).
 *
 * Le format est vieux, et c'est sa qualité : Premiere Pro l'importe depuis quinze ans
 * (Fichier > Importer), DaVinci Resolve et Final Cut aussi, sans plugin et sans dépendre de la
 * version installée chez le monteur. Le FCPXML récent n'est pas lu par Premiere, l'EDL ne porte
 * qu'une piste vidéo et perd les noms de fichiers.
 *
 * Le fichier ne contient que des références : les rushes restent où ils sont, Premiere les relie
 * par leur chemin absolu. Déplacer le dossier des rushes demandera de les relier à la main.
 */

export type MediaFile = {
  readonly path: string;
  readonly durationS: number;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly audioChannels: number;
  readonly sampleRate: number;
};

export type SequenceClip = {
  /** Rang dans `media`. */
  readonly media: number;
  /**
   * Rang dans `media` du fichier qui porte le son, quand ce n'est pas la vidéo : un enregistreur
   * séparé, conformé sur la timeline de la vidéo (même origine, même durée — voir `audio-sync.ts`).
   * Les `in`/`out` sont alors les mêmes pour l'image et le son.
   */
  readonly audioMedia?: number | undefined;
  readonly inS: number;
  readonly outS: number;
  readonly name: string;
};

export type SequenceMarker = {
  readonly atS: number;
  readonly name: string;
  readonly comment: string;
};

export type Sequence = {
  readonly name: string;
  readonly clips: readonly SequenceClip[];
  /** Positions en secondes **dans la séquence**, pas dans le rush. */
  readonly markers: readonly SequenceMarker[];
};

type Rate = { readonly timebase: number; readonly ntsc: boolean; readonly exact: number };

/** 29,97 s'écrit timebase 30 + NTSC ; 25 s'écrit timebase 25. */
export function rateOf(fps: number): Rate {
  const timebase = Math.round(fps);
  const ntsc = Math.abs(fps - timebase) > 0.01;
  return { timebase, ntsc, exact: ntsc ? (timebase * 1000) / 1001 : timebase };
}

export function toFrames(seconds: number, rate: Rate): number {
  return Math.round(seconds * rate.exact);
}

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** `file://localhost/...` encodé segment par segment : c'est ce que Premiere sait relier. */
export function pathUrl(path: string): string {
  return `file://localhost${path.split('/').map(encodeURIComponent).join('/')}`;
}

function rateXml(rate: Rate): string {
  return `<rate><timebase>${rate.timebase}</timebase><ntsc>${rate.ntsc ? 'TRUE' : 'FALSE'}</ntsc></rate>`;
}

export function buildXmeml(
  project: string,
  media: readonly MediaFile[],
  sequences: readonly Sequence[],
): string {
  const first = media[0];
  if (first === undefined) throw new Error('buildXmeml : aucun média.');

  // Une séquence a une seule cadence : celle du premier rush. Des rushes à cadences mêlées
  // s'importent quand même — Premiere les conforme — mais c'est à signaler au monteur.
  const seqRate = rateOf(first.fps);
  const declared = new Set<number>();

  const fileXml = (index: number): string => {
    const file = media[index];
    if (file === undefined) throw new Error(`buildXmeml : média ${index} absent.`);
    const id = `file-${index + 1}`;
    if (declared.has(index)) return `<file id="${id}"/>`;
    declared.add(index);
    const rate = rateOf(file.fps);
    const audio =
      file.audioChannels > 0
        ? `<audio><samplecharacteristics><depth>16</depth><samplerate>${file.sampleRate}</samplerate></samplecharacteristics><channelcount>${file.audioChannels}</channelcount></audio>`
        : '';
    // Un fichier sans image (enregistreur) ne déclare pas de piste vidéo : Premiere refuserait
    // de relier un wav annoncé en 1920×1080.
    const video =
      file.width > 0
        ? `<video><samplecharacteristics>${rateXml(rate)}<width>${file.width}</width><height>${file.height}</height></samplecharacteristics></video>`
        : '';
    return (
      `<file id="${id}"><name>${esc(basename(file.path))}</name><pathurl>${esc(pathUrl(file.path))}</pathurl>` +
      `${rateXml(rate)}<duration>${toFrames(file.durationS, rate)}</duration>` +
      `<media>${video}${audio}</media></file>`
    );
  };

  const sequenceXml = (sequence: Sequence, s: number): string => {
    // Deux pistes audio au plus : au-delà (enregistreur multipiste), le monteur remappe lui-même.
    const audioTracks = Math.min(
      2,
      Math.max(0, ...sequence.clips.map((c) => media[c.audioMedia ?? c.media]?.audioChannels ?? 0)),
    );

    let cursor = 0;
    const video: string[] = [];
    const audio: string[][] = Array.from({ length: audioTracks }, () => []);

    sequence.clips.forEach((clip, c) => {
      const file = media[clip.media];
      if (file === undefined) return;
      const rate = rateOf(file.fps);
      const inF = toFrames(clip.inS, rate);
      const outF = toFrames(clip.outS, rate);
      const length = outF - inF;
      if (length <= 0) return;
      const start = cursor;
      const end = cursor + length;
      cursor = end;

      const vid = `v-${s}-${c}`;
      const audioIndex = clip.audioMedia ?? clip.media;
      const audioFile = media[audioIndex] ?? file;
      const channels = Math.min(audioTracks, audioFile.audioChannels);
      const aids = Array.from({ length: channels }, (_, t) => `a${t + 1}-${s}-${c}`);
      const links = [
        `<link><linkclipref>${vid}</linkclipref><mediatype>video</mediatype><trackindex>1</trackindex><clipindex>${c + 1}</clipindex></link>`,
        ...aids.map(
          (aid, t) =>
            `<link><linkclipref>${aid}</linkclipref><mediatype>audio</mediatype><trackindex>${t + 1}</trackindex><clipindex>${c + 1}</clipindex></link>`,
        ),
      ].join('');
      const body = (id: string, extra: string): string =>
        `<clipitem id="${id}"><name>${esc(clip.name)}</name><enabled>TRUE</enabled>` +
        `<duration>${toFrames(file.durationS, rate)}</duration>${rateXml(rate)}` +
        `<start>${start}</start><end>${end}</end><in>${inF}</in><out>${outF}</out>` +
        `${extra}${links}</clipitem>`;

      video.push(body(vid, fileXml(clip.media)));
      aids.forEach((aid, t) => {
        audio[t]?.push(
          body(
            aid,
            `${fileXml(audioIndex)}<sourcetrack><mediatype>audio</mediatype><trackindex>${t + 1}</trackindex></sourcetrack>`,
          ),
        );
      });
    });

    const markers = sequence.markers
      .map(
        (m) =>
          `<marker><name>${esc(m.name)}</name><comment>${esc(m.comment)}</comment><in>${toFrames(m.atS, seqRate)}</in><out>-1</out></marker>`,
      )
      .join('');

    return (
      `<sequence id="sequence-${s + 1}"><name>${esc(sequence.name)}</name><duration>${cursor}</duration>${rateXml(seqRate)}` +
      `<timecode>${rateXml(seqRate)}<string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode>` +
      `${markers}<media>` +
      `<video><format><samplecharacteristics>${rateXml(seqRate)}<width>${first.width}</width><height>${first.height}</height><pixelaspectratio>square</pixelaspectratio></samplecharacteristics></format>` +
      `<track>${video.join('')}</track></video>` +
      `<audio><numOutputChannels>2</numOutputChannels><format><samplecharacteristics><depth>16</depth><samplerate>${first.sampleRate}</samplerate></samplecharacteristics></format>` +
      audio.map((items) => `<track>${items.join('')}</track>`).join('') +
      `</audio></media></sequence>`
    );
  };

  return (
    // Le chutier `project` regroupe les séquences : Premiere le recrée tel quel à l'import.
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="4">` +
    `<project><name>${esc(project)}</name><children>` +
    sequences.map(sequenceXml).join('') +
    `</children></project></xmeml>\n`
  );
}
