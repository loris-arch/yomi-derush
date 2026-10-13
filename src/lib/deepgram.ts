import { readFile } from 'node:fs/promises';

import type { Transcript, TranscriptWord } from './transcript.js';
import { z } from 'zod';

import { deepgramApiKey } from './env.js';

/**
 * Accès à Deepgram (`nova-3`, français, ponctuation forte, diarisation).
 *
 * Choisi pour un dérush parce qu'il transcrit **mot à mot** : les répétitions et faux départs
 * restent dans le texte (6 répétitions sur 5 min de C0055, contre 0 pour Whisper, qui écrit ce
 * que la personne voulait dire). Sans eux, on ne voit pas les reprises. La ponctuation sert au
 * découpage en phrases. ATTENTION — la fin d'un mot (`end`) est le début du suivant, pause
 * comprise : elle ne dit rien de la fin réelle du mot. Les coupes se calent sur le son.
 */

export class DeepgramError extends Error {}

/**
 * Réponse illisible ou hors schéma. Distincte pour la même raison que `LlmOutputError` :
 * l'appelant doit savoir si le problème vient du réseau, de la clé, ou du contenu.
 */
export class DeepgramOutputError extends DeepgramError {}

/* ------------------------------------------------------------------ */
/* Forme de la réponse                                                 */
/* ------------------------------------------------------------------ */

/**
 * Schéma volontairement permissif sur ce qu'on n'utilise pas : Deepgram ajoute des champs au fil
 * des versions, et une réponse enrichie n'est pas une réponse cassée. Ce qui est exigé ici est
 * exactement ce dont le reste du moteur dépend.
 */
const deepgramWord = z.object({
  word: z.string(),
  start: z.number(),
  end: z.number(),
  confidence: z.number(),
  /** Présent dès que `diarize=true`. Son absence signifie que le paramètre n'a pas pris. */
  speaker: z.number().int().nonnegative(),
  /** Deepgram donne sa propre incertitude sur l'attribution — on la mesure au lieu de la deviner. */
  speaker_confidence: z.number().optional(),
  /** Le mot avec sa ponctuation et sa majuscule. C'est lui qu'on garde, pas `word`. */
  punctuated_word: z.string().optional(),
});

const deepgramResponse = z.object({
  metadata: z.object({ duration: z.number() }),
  results: z.object({
    channels: z
      .array(
        z.object({
          alternatives: z
            .array(z.object({ transcript: z.string(), words: z.array(deepgramWord) }))
            .min(1),
        }),
      )
      .min(1),
  }),
});

export type DeepgramSpeakerStats = {
  readonly speaker: number;
  readonly wordCount: number;
  readonly speechS: number;
};

export type DeepgramResult = {
  readonly transcript: Transcript;
  /** Durée vue par Deepgram. Sert de recoupement avec `ffprobe` : un écart signale un fichier tronqué. */
  readonly durationS: number;
  readonly meanConfidence: number;
  /** Confiance moyenne d'attribution, quand Deepgram la fournit. Journalisée, jamais bloquante. */
  readonly meanSpeakerConfidence: number | null;
  readonly speakers: readonly DeepgramSpeakerStats[];
};

export type DeepgramRequest = {
  /** Entité traitée, pour les logs. */
  readonly subject: string;
  /** Fichier audio déjà extrait et compressé — voir `extractAudio` dans `ffmpeg.ts`. */
  readonly audioPath: string;
};

export type DeepgramClient = {
  readonly name: 'deepgram';
  readonly transcribe: (request: DeepgramRequest) => Promise<DeepgramResult>;
};

/* ------------------------------------------------------------------ */
/* Conversion                                                          */
/* ------------------------------------------------------------------ */

const MODEL = 'nova-3';
const LANGUAGE = 'fr';

/** Un épisode de 2 h 45 se transcrit en quelques minutes. Large, mais borné. */
const REQUEST_TIMEOUT_MS = 20 * 60 * 1000;

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function statsOf(words: readonly TranscriptWord[], raw: readonly z.infer<typeof deepgramWord>[]) {
  const bySpeaker = new Map<number, { wordCount: number; speechS: number }>();

  for (const word of words) {
    const entry = bySpeaker.get(word.speaker) ?? { wordCount: 0, speechS: 0 };
    entry.wordCount += 1;
    entry.speechS += word.end - word.start;
    bySpeaker.set(word.speaker, entry);
  }

  const speakers = [...bySpeaker.entries()]
    .map(([speaker, entry]) => ({ speaker, wordCount: entry.wordCount, speechS: entry.speechS }))
    .sort((a, b) => b.wordCount - a.wordCount);

  const speakerConfidences = raw
    .map((word) => word.speaker_confidence)
    .filter((value): value is number => value !== undefined);

  return {
    speakers,
    meanConfidence: mean(raw.map((word) => word.confidence)) ?? 0,
    meanSpeakerConfidence: mean(speakerConfidences),
  };
}

/**
 * Traduit la réponse Deepgram en `Transcript`, la structure que tout le moteur lit déjà.
 *
 * Deux points qui ne sont pas des détails :
 *
 * 1. On garde `punctuated_word` et non `word`. La ponctuation est la raison d'être de ce
 *    chantier côté découpe — la jeter ici annulerait le choix de `nova-3`.
 * 2. `end` vient de Deepgram, il n'est pas déduit du mot suivant comme dans `captions.ts`.
 *    C'est ce qui rend `measuresPauses()` vrai pour `deepgram` : l'écart entre la fin d'un mot
 *    et le début du suivant est ici une vraie pause, pas un artefact de reconstruction.
 */
export function parseDeepgram(raw: unknown): DeepgramResult {
  const result = deepgramResponse.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(racine)'} : ${issue.message}`)
      .join(' ; ');
    throw new DeepgramOutputError(
      `Réponse Deepgram hors schéma — ${issues}. ` +
        `Un champ « speaker » manquant signifie que « diarize » n'a pas été pris en compte.`,
    );
  }

  const alternative = result.data.results.channels[0]?.alternatives[0];
  if (alternative === undefined || alternative.words.length === 0) {
    throw new DeepgramOutputError(
      'Réponse Deepgram vide : aucun mot transcrit. Piste audio muette ou illisible.',
    );
  }

  const words: TranscriptWord[] = alternative.words.map((word) => ({
    w: word.punctuated_word ?? word.word,
    start: Number(word.start.toFixed(3)),
    end: Number(word.end.toFixed(3)),
    speaker: word.speaker,
  }));

  return {
    transcript: { words, text: alternative.transcript, source: 'deepgram' },
    durationS: result.data.metadata.duration,
    ...statsOf(words, alternative.words),
  };
}

/* ------------------------------------------------------------------ */
/* Implémentations                                                     */
/* ------------------------------------------------------------------ */

function endpoint(): string {
  const params = new URLSearchParams({
    model: MODEL,
    language: LANGUAGE,
    diarize: 'true',
    punctuate: 'true',
  });
  return `https://api.deepgram.com/v1/listen?${params.toString()}`;
}

export function deepgramClient(): DeepgramClient {
  const apiKey = deepgramApiKey();
  if (apiKey === null) {
    throw new DeepgramError(
      'DEEPGRAM_API_KEY absente. Renseigne-la dans le fichier .env à la racine du dépôt ' +
        '(voir .env.example), ou lance avec --asr whisper pour transcrire en local.',
    );
  }

  return {
    name: 'deepgram',
    async transcribe(request: DeepgramRequest): Promise<DeepgramResult> {
      // Le fichier est déjà compressé en opus mono (~29 Mo pour 2 h 45) : le charger en mémoire
      // plutôt que de l'émettre en flux donne un Content-Length, ce qui évite le transfert
      // découpé et permet à l'API de rejeter tout de suite un envoi manifestement trop gros.
      const audio = await readFile(request.audioPath);

      let response: Response;
      try {
        response = await fetch(endpoint(), {
          method: 'POST',
          headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'audio/ogg' },
          body: audio,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        throw new DeepgramError(
          `Deepgram injoignable : ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (!response.ok) {
        const body = (await response.text()).slice(0, 400);
        throw new DeepgramError(`Deepgram : erreur ${response.status} — ${body}`);
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new DeepgramOutputError('Réponse Deepgram illisible : ce n’est pas du JSON.');
      }

      return parseDeepgram(payload);
    },
  };
}

export function asrClient(): DeepgramClient {
  return deepgramClient();
}
