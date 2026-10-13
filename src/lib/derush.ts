import type { TranscriptWord } from './transcript.js';

/**
 * Dérush d'un tournage : la partie déterministe, sans appel ni fichier.
 *
 * Le modèle ne manipule jamais de secondes. Il lit des phrases numérotées (`A12`, `B3`…) et
 * rend des plages « de telle phrase à telle phrase ». C'est le code qui transforme ces plages en
 * points d'entrée et de sortie, au mot près, à partir des horodatages de Deepgram — un modèle qui
 * recopie des timecodes en arrondit un sur dix, et une coupe à 200 ms près ampute une syllabe.
 */

/** Une phrase dite d'une traite dans un rush. C'est l'unité que le modèle garde ou jette. */
export type Phrase = {
  readonly id: string;
  /** Rang du rush dans la liste fournie, à partir de 0. */
  readonly rush: number;
  readonly startS: number;
  readonly endS: number;
  /** Silence avant la phrase. Un long blanc trahit souvent une reprise. */
  readonly gapBeforeS: number;
  readonly text: string;
  /** Indices du premier et du dernier mot dans le transcript du rush. */
  readonly firstWord: number;
  readonly lastWord: number;
};

/**
 * Au-delà de ce blanc entre deux mots, on ouvre une nouvelle phrase même sans ponctuation.
 * Un faux départ se reconnaît presque toujours à cette pause : « Le dropshipping c'est… (0,8 s)
 * Le dropshipping, c'est un business ». Sans elle, la reprise et le faux départ tomberaient dans
 * la même unité et le modèle ne pourrait garder l'une sans l'autre.
 */
export const PHRASE_GAP_S = 0.5;

/** Garde-fou : une phrase sans ponctuation ni pause ne doit pas avaler une minute de rush. */
const PHRASE_MAX_WORDS = 45;

const SENTENCE_END = /[.?!…]["»]?$/;

/**
 * Recolle les mots comme on les écrit. Whisper rend « c'est » en deux jetons, « c » et « 'est » :
 * joints par une espace, le texte se lit mal et se cite mal.
 */
export function joinWords(words: readonly TranscriptWord[]): string {
  return words.reduce((text, word, i) => {
    if (i === 0) return word.w;
    return /^['’-]/.test(word.w) ? `${text}${word.w}` : `${text} ${word.w}`;
  }, '');
}

/** `A`, `B`… puis `AA` au-delà de 26 rushes. */
export function rushLetter(rush: number): string {
  let n = rush;
  let letters = '';
  do {
    letters = String.fromCharCode(65 + (n % 26)) + letters;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return letters;
}

export function splitPhrases(words: readonly TranscriptWord[], rush: number): Phrase[] {
  const phrases: Phrase[] = [];
  const letter = rushLetter(rush);
  let first = 0;

  const close = (last: number): void => {
    const head = words[first];
    const tail = words[last];
    if (head === undefined || tail === undefined) return;
    const previous = words[first - 1];
    phrases.push({
      id: `${letter}${phrases.length + 1}`,
      rush,
      startS: head.start,
      endS: tail.end,
      gapBeforeS: previous === undefined ? head.start : head.start - previous.end,
      text: joinWords(words.slice(first, last + 1)),
      firstWord: first,
      lastWord: last,
    });
    first = last + 1;
  };

  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    const next = words[i + 1];
    if (word === undefined) continue;
    if (
      next === undefined ||
      SENTENCE_END.test(word.w) ||
      next.start - word.end >= PHRASE_GAP_S ||
      i - first + 1 >= PHRASE_MAX_WORDS
    ) {
      close(i);
    }
  }

  return phrases;
}

function clock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

/** Une ligne par phrase : ce que lit le modèle. */
export function formatPhrases(phrases: readonly Phrase[]): string {
  return phrases
    .map((p) => {
      const pause = p.gapBeforeS >= 1 ? ` (blanc ${p.gapBeforeS.toFixed(1)} s)` : '';
      return `${p.id} [${clock(p.startS)}]${pause} ${p.text}`;
    })
    .join('\n');
}

/**
 * Une plage choisie par le modèle, d'une phrase à une autre du même rush.
 *
 * `from` et `to` coupent **à l'intérieur** d'une phrase, en citant ses mots. Indispensable sur un
 * rush réel : Yomi reprend souvent sans marquer de pause (« une fois que vous l'avez, vous avez,
 * mais une fois que vous l'avez, eh bien, vous pouvez postuler »), et la phrase entière contient
 * alors la prise ratée et la bonne. Une citation plutôt qu'un numéro de mot : c'est ce qu'un
 * modèle recopie sans se tromper.
 */
export type Pick = {
  readonly first: string;
  readonly last: string;
  /** Premiers mots gardés dans `first`. Cités plusieurs fois dans la phrase : la dernière occurrence, celle de la reprise. */
  readonly from?: string | undefined;
  /** Derniers mots gardés dans `last`. La première occurrence après le début de la plage. */
  readonly to?: string | undefined;
};

/** Intervalle silencieux dans un rush, en secondes absolues — ce que renvoie `detectSilences`. */
export type Silence = { readonly startS: number; readonly endS: number };

export type Cut = {
  readonly rush: number;
  readonly inS: number;
  readonly outS: number;
  /**
   * Bornes qui n'ont trouvé aucun silence où se poser : la coupe tombe en pleine voix, ou dans
   * une reprise enchaînée sans respirer. Le monteur doit l'écouter. Vide quand tout va bien.
   */
  readonly unsafe: readonly ('in' | 'out')[];
  /** Mots embarqués en plus par l'extension (début, fin). 0 quand la coupe tombe où le texte le voulait. */
  readonly extended: readonly [number, number];
};

export type CutOptions = {
  /** Marge gardée avant le premier mot, prise dans le silence qui précède. */
  readonly padStartS: number;
  /** Marge gardée après le dernier mot, prise dans le silence qui suit — la fin d'un mot traîne. */
  readonly padEndS: number;
  /**
   * Un blanc plus long que ça à l'intérieur d'une plage gardée est retiré (jump cut).
   * `Infinity` garde les plages d'un seul tenant.
   */
  readonly maxGapS: number;
  /** Distance maximale entre le mot et le silence sur lequel on cale la coupe. */
  readonly snapS: number;
  /** Ce qu'on laisse d'une pause interne resserrée : la respiration qui porte le rythme. */
  readonly gapKeepS: number;
  /**
   * Faute de silence au point voulu, jusqu'où l'on étend la coupe pour en trouver un — au prix de
   * quelques mots en plus (la fin d'une tentative abandonnée, l'amorce d'une reprise).
   *
   * Essayé le 2026-10-13 à 0,7 s / 3 mots sur C0055 : 41 coupes en pleine voix de moins, mais
   * une quinzaine de bafouillages de plus (« on va on va commencer », « à coups de à coups de »),
   * et Loris entend un bafouillage bien plus qu'une coupe sèche. Désactivé par défaut (0).
   */
  readonly extendS: number;
  readonly extendMaxWords: number;
};

/**
 * Le rapport « Workflow de dérush automatique » (reports/) conseillait 40–100 ms avant et
 * 150–250 ms après. Loris a tranché le 2026-10-13 pour un montage énergique : coupe collée à la
 * fin du son, reprise collée au départ du suivant, pas de fondu. Les marges résiduelles ne sont
 * là que pour ne pas manger une consonne que l'énergie voit mal ; les bornes exactes viennent de
 * `firstVoiced` / `lastVoiced`.
 */
export const DEFAULT_CUT_OPTIONS: CutOptions = {
  padStartS: 0.02,
  padEndS: 0.03,
  maxGapS: 0.6,
  gapKeepS: 0.3,
  snapS: 0.6,
  extendS: 0,
  extendMaxWords: 3,
};

/**
 * Jeu entre les horodatages ASR et le son. Deepgram étire chaque mot jusqu'au début du suivant
 * (`end` = `start` du mot d'après, même à travers une respiration) et YouTube fait pareil : la fin
 * d'un mot n'est donc jamais fiable, son début l'est à ~100 ms près. Les silences mesurés dans
 * l'audio, eux, sont exacts — on ne garde de l'ASR que l'ordre des mots.
 *
 * Côté sortie, voir `OUT_TOLERANCE_S` : constaté le 2026-10-13, à 300 ms trois mots courts du
 * voisin (« ça peut être ») tenaient dans la tolérance et ressortaient doublés dans le montage.
 */
export const TIMESTAMP_TOLERANCE_S = 0.3;

/**
 * Jeu après le début ASR du mot *suivant* pour une sortie. Plus serré que la tolérance d'entrée :
 * une entrée posée dans un silence qui finit un peu après le début ASR du mot ne contient rien
 * d'autre que ce mot, alors qu'une sortie posée dans un silence qui commence un peu après le mot
 * suivant contient ce mot suivant — et trois mots courts tiennent dans 300 ms.
 */
export const OUT_TOLERANCE_S = 0.06;

/**
 * Jeu *avant* le début ASR du mot pour une entrée : un silence qui finit plus tôt que ça laisse
 * passer de la parole d'avant (« c'est » devant « souvent la meilleure façon », constaté le
 * 2026-10-13 avec 600 ms). Le début ASR d'un mot est rarement en retard de plus de 150 ms.
 */
export const IN_LAG_S = 0.15;

/**
 * Au-delà de cette distance entre le début d'un mot et le silence qui le suit, ce n'est plus la
 * respiration d'après le mot mais un blanc du rush (reprise 30 s plus loin) : on ne va pas le
 * chercher. Constaté le 2026-10-13 : la sortie calée sur le silence d'avant le mot suivant
 * embarquait des blancs entiers, 5 min de plus sur un montage de 18.
 */
export const MAX_WORD_S = 2.0;

/**
 * Durée minimale accordée à un mot que l'énergie ne voit pas : une sortie ne tombe jamais à moins
 * de ça du début du dernier mot gardé, même si le silence mesuré commence avec lui.
 */
export const MIN_WORD_S = 0.2;

/**
 * Seuil « doux » pour trouver le vrai départ ou la vraie fin de la voix à l'intérieur d'un
 * silence retenu : quelques dB sous le seuil voix/silence. Un « Lui » ou un « p » d'attaque
 * passe sous le seuil principal mais pas sous celui-ci ; le souffle reste dessous.
 *
 * D'abord posé à 15 % du chemin plancher → parole : juste sur un son de caméra (plancher −45,
 * parole −29, soit −43), dans le souffle sur un enregistreur propre (plancher −75 : −70). La
 * voix y « durait » tant que la pièce respirait, 0,5 s de plat avant chaque coupe et un départ
 * pris dès l'inspiration d'avant (capture du 2026-10-13). Relatif au seuil, il tombe au bon
 * endroit dans les deux cas ; borné au-dessus du plancher pour une caméra bruyante.
 */
export const SOFT_BELOW_DB = 6;
export const SOFT_ABOVE_FLOOR_DB = 6;

/**
 * Cale une entrée sur le silence qui précède le premier mot gardé.
 *
 * Direction imposée : en arrière seulement. Le silence retenu finit au plus `snapS` avant le
 * début ASR du mot (ou le chevauche de `TIMESTAMP_TOLERANCE_S`, quand l'ASR a placé le mot un
 * peu tôt), et commence après le début du mot précédent — un silence qui engloberait ce mot ne
 * serait pas un silence. L'entrée se pose juste avant la reprise de la voix, moins la marge.
 */
export function snapIn(
  wordStart: number,
  previousStart: number | undefined,
  silences: readonly Silence[],
  options: CutOptions,
  energy?: Energy,
  /** Débuts des mots qui précèdent, du plus proche au plus lointain : pour l'extension. */
  previousStarts: readonly number[] = [],
): { readonly atS: number; readonly safe: boolean; readonly extendedWords: number } {
  const floor = previousStart === undefined ? 0 : previousStart + 0.05;
  let candidate = silences
    .filter((sil) => sil.endS <= wordStart + TIMESTAMP_TOLERANCE_S && sil.endS >= wordStart - IN_LAG_S)
    .filter((sil) => sil.startS >= floor)
    .at(-1);
  let extendedWords = 0;
  if (candidate === undefined && options.extendS > 0) {
    // Pas de silence juste avant le mot : le plus proche en remontant, s'il est à moins de
    // `extendS` et n'embarque pas plus de `extendMaxWords` mots.
    const earlier = silences
      .filter((sil) => sil.endS < wordStart - IN_LAG_S && sil.endS >= wordStart - options.extendS)
      .at(-1);
    if (earlier !== undefined) {
      const swallowed = previousStarts.filter((t) => t >= earlier.endS - 0.05).length;
      if (swallowed <= options.extendMaxWords) {
        candidate = earlier;
        extendedWords = swallowed;
      }
    }
  }
  if (candidate === undefined) {
    // Pas de respiration : on coupe au creux d'énergie le plus proche, juste avant le mot, et on
    // le dit. Mieux que l'horodatage ASR, qui tombe au hasard dans une syllabe.
    const from = Math.max(floor, wordStart - 0.25);
    const atS = energy === undefined ? Math.max(0, wordStart - 0.03) : quietestInstant(energy, from, wordStart + 0.02);
    return { atS, safe: false, extendedWords: 0 };
  }
  // Le vrai départ de la voix : première fenêtre au-dessus du seuil doux après le silence, en
  // remontant jusqu'à 0,5 s avant le début ASR du mot (qui peut être en retard). À défaut, la fin
  // mesurée du silence — jamais après le début ASR, sinon on mangerait une attaque douce.
  const onset =
    energy === undefined
      ? Math.min(candidate.endS, wordStart)
      : firstVoiced(energy, Math.max(candidate.startS, wordStart - 0.35), Math.min(candidate.endS, wordStart));
  return { atS: Math.max(candidate.startS, onset - options.padStartS), safe: true, extendedWords };
}

/** Courbe d'énergie du rush, pour couper au creux quand aucun silence ne se présente. */
export type Energy = {
  readonly levels: readonly number[];
  readonly windowS: number;
  readonly floorDb: number;
  readonly speechDb: number;
  /** Seuil voix / silence du fichier. */
  readonly thresholdDb: number;
};

function softThreshold(energy: Energy): number {
  return Math.max(energy.thresholdDb - SOFT_BELOW_DB, energy.floorDb + SOFT_ABOVE_FLOOR_DB);
}

/**
 * Départ de la rampe de voix qui aboutit à `toS` : en remontant depuis `toS`, le premier instant
 * avant lequel le niveau retombe sous le seuil doux. `toS` si la rampe ne commence pas avant.
 */
export function firstVoiced(energy: Energy, fromS: number, toS: number): number {
  const soft = softThreshold(energy);
  const first = Math.max(0, Math.floor(fromS / energy.windowS));
  let i = Math.min(energy.levels.length - 1, Math.floor(toS / energy.windowS));
  while (i - 1 >= first && (energy.levels[i - 1] ?? -Infinity) >= soft) i -= 1;
  return Math.min(toS, i * energy.windowS);
}

/**
 * Fin de la queue de voix qui part de `fromS` : en avançant depuis `fromS`, le dernier instant
 * jusqu'auquel le niveau reste au-dessus du seuil doux. `fromS` si la queue est déjà finie.
 */
export function lastVoiced(energy: Energy, fromS: number, toS: number): number {
  const soft = softThreshold(energy);
  const last = Math.min(energy.levels.length - 1, Math.floor(toS / energy.windowS));
  let i = Math.max(0, Math.floor(fromS / energy.windowS));
  while (i <= last && (energy.levels[i] ?? -Infinity) >= soft) i += 1;
  return Math.max(fromS, Math.min(toS, i * energy.windowS));
}

/** Instant de niveau minimal dans [fromS, toS], au pas de la courbe. */
export function quietestInstant(energy: Energy, fromS: number, toS: number): number {
  const first = Math.max(0, Math.floor(fromS / energy.windowS));
  const last = Math.min(energy.levels.length - 1, Math.floor(toS / energy.windowS));
  let best = first;
  for (let i = first; i <= last; i += 1) {
    if ((energy.levels[i] ?? Infinity) < (energy.levels[best] ?? Infinity)) best = i;
  }
  return best * energy.windowS;
}

/**
 * Cale une sortie sur le silence qui sépare le dernier mot gardé du mot suivant.
 *
 * La référence est le **début du mot suivant**, pas la fin ASR du mot : chez Deepgram la fin
 * d'un mot *est* le début du suivant, pause comprise, et chercher « un silence après la fin du
 * mot » trouvait un creux entre deux syllabes (« em-plois », constaté le 2026-10-13, le mot
 * sortait coupé en deux). Le silence retenu commence après le début du mot et finit au voisinage
 * du mot suivant ; la sortie se pose à son début, plus la marge, sans jamais atteindre sa fin.
 */
export function snapOut(
  wordStart: number,
  wordEnd: number,
  nextStart: number | undefined,
  silences: readonly Silence[],
  durationS: number,
  options: CutOptions,
  energy?: Energy,
  /** Débuts des mots qui suivent, du plus proche au plus lointain : pour l'extension. */
  nextStarts: readonly number[] = [],
): { readonly atS: number; readonly safe: boolean; readonly extendedWords: number } {
  const ref = nextStart ?? wordEnd;
  // Un mot court et sourd (« an. ») commence, pour l'énergie, avant son horodatage : le silence
  // qui le suit peut démarrer un peu avant `wordStart`. D'où la tolérance vers l'arrière.
  const after = silences.filter(
    (sil) => sil.startS >= wordStart - 0.1 && sil.startS <= Math.min(ref + OUT_TOLERANCE_S, wordStart + MAX_WORD_S),
  );
  // Le **premier** silence franc après le mot. Une pause est souvent fragmentée par un bruit de
  // bouche en deux ou trois silences : prendre celui qui touche le mot suivant embarquait toute
  // la pause (1,47 s avant « Si c'est quelque chose », 2026-10-13). Un creux de moins de 200 ms
  // peut être un creux entre deux syllabes : on ne s'y fie que s'il touche le mot suivant.
  let candidate =
    after.find((sil) => sil.endS - sil.startS >= 0.2) ??
    after.find((sil) => sil.endS >= ref - IN_LAG_S) ??
    after[0];
  let extendedWords = 0;
  if (candidate === undefined && options.extendS > 0 && nextStart !== undefined) {
    // Pas de silence avant le mot suivant : le premier après lui, s'il est à moins de `extendS`
    // et n'embarque pas plus de `extendMaxWords` mots de la reprise.
    const later = silences.find((sil) => sil.startS > ref && sil.startS <= ref + options.extendS && sil.endS - sil.startS >= 0.12);
    if (later !== undefined) {
      const swallowed = nextStarts.filter((t) => t <= later.startS + 0.05).length;
      if (swallowed <= options.extendMaxWords) {
        candidate = later;
        extendedWords = swallowed;
      }
    }
  }
  if (candidate === undefined) {
    // Pas de respiration : au creux d'énergie le plus proche, et on le dit. Juste avant le mot
    // suivant quand il enchaîne ; juste après le mot quand le suivant est loin (un blanc bruyant,
    // sans silence franc — on ne va pas embarquer le blanc).
    const far = ref - wordStart > MAX_WORD_S;
    const from = far ? wordStart + 0.05 : Math.max(wordStart + 0.05, ref - 0.15);
    const to = Math.min(far ? wordStart + MAX_WORD_S : ref + 0.02, durationS);
    const atS = energy === undefined ? Math.min(durationS, far ? wordEnd : ref) : quietestInstant(energy, from, to);
    return { atS, safe: false, extendedWords: 0 };
  }
  // La vraie fin de la voix : dernière fenêtre au-dessus du seuil doux avant le silence (une
  // finale sourde passe sous le seuil principal et le silence « commence » trop tôt).
  const offset =
    energy === undefined
      ? candidate.startS
      : lastVoiced(energy, candidate.startS, Math.min(candidate.endS, candidate.startS + 0.2));
  const atS = Math.max(Math.min(candidate.endS, offset + options.padEndS), Math.min(wordStart + MIN_WORD_S, ref));
  return { atS, safe: true, extendedWords };
}

/** Mots réduits à leurs lettres et chiffres, chacun rattaché au mot du transcript d'où il vient. */
function tokens(words: readonly TranscriptWord[], from: number, to: number): { tok: string; word: number }[] {
  const out: { tok: string; word: number }[] = [];
  for (let i = from; i <= to; i += 1) {
    for (const tok of normalize(words[i]?.w ?? '')) out.push({ tok, word: i });
  }
  return out;
}

function normalize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t !== '');
}

/** Positions (indices de jeton) où la citation commence dans `hay`. */
function occurrences(hay: readonly { tok: string }[], quote: readonly string[]): number[] {
  const found: number[] = [];
  for (let i = 0; i + quote.length <= hay.length; i += 1) {
    if (quote.every((q, k) => hay[i + k]?.tok === q)) found.push(i);
  }
  return found;
}

/**
 * Indices du premier et du dernier mot gardés, `from` et `to` appliqués.
 * `null` avec un motif quand une citation est introuvable : le modèle doit la corriger.
 */
export function resolveRange(
  pick: Pick,
  byId: ReadonlyMap<string, Phrase>,
  words: readonly TranscriptWord[],
): { readonly start: number; readonly end: number } | string {
  const first = byId.get(pick.first);
  const last = byId.get(pick.last);
  if (first === undefined || last === undefined) return `plage ${pick.first}–${pick.last} inconnue`;

  let start = first.firstWord;
  if (pick.from !== undefined && pick.from.trim() !== '') {
    const quote = normalize(pick.from);
    const hay = tokens(words, first.firstWord, first.lastWord);
    const at = occurrences(hay, quote).at(-1);
    const hit = at === undefined ? undefined : hay[at];
    if (hit === undefined) return `« ${pick.from} » n'apparaît pas dans ${pick.first}`;
    start = hit.word;
  }

  let end = last.lastWord;
  if (pick.to !== undefined && pick.to.trim() !== '') {
    const quote = normalize(pick.to);
    const from = Math.max(start, last.firstWord);
    const hay = tokens(words, from, last.lastWord);
    const at = occurrences(hay, quote)[0];
    const hit = at === undefined ? undefined : hay[at + quote.length - 1];
    if (hit === undefined) return `« ${pick.to} » n'apparaît pas dans ${pick.last}`;
    end = hit.word;
  }

  if (end < start) return `${pick.first}–${pick.last} : la fin citée tombe avant le début cité`;
  return { start, end };
}

/** Vérifie qu'une plage désigne deux phrases existantes, du même rush, dans l'ordre. */
export function checkPick(
  pick: Pick,
  byId: ReadonlyMap<string, Phrase>,
  words?: readonly TranscriptWord[],
): string | null {
  const first = byId.get(pick.first);
  const last = byId.get(pick.last);
  if (first === undefined) return `« ${pick.first} » n'est pas un numéro de phrase de la liste`;
  if (last === undefined) return `« ${pick.last} » n'est pas un numéro de phrase de la liste`;
  if (first.rush !== last.rush) {
    return `${pick.first}–${pick.last} enjambe deux rushes : une plage reste dans un seul rush`;
  }
  if (last.firstWord < first.firstWord) {
    return `${pick.first}–${pick.last} est à l'envers : la première phrase vient après la dernière`;
  }
  if (words !== undefined) {
    const range = resolveRange(pick, byId, words);
    if (typeof range === 'string') return range;
  }
  return null;
}

/**
 * Transforme une plage de phrases en coupes, au mot près — et posées sur le son.
 *
 * Le texte dit *quoi* garder, le silence mesuré dans l'audio dit *où* couper : les horodatages
 * de l'ASR désignent une zone à 50–100 ms près, pas une coupe. Chaque borne est calée sur le
 * silence voisin (`snapIn` / `snapOut`) ; faute de silence, elle est posée au plus près du mot
 * et marquée `unsafe` pour que le monteur l'écoute.
 */
export function pickToCuts(
  pick: Pick,
  byId: ReadonlyMap<string, Phrase>,
  words: readonly TranscriptWord[],
  durationS: number,
  silences: readonly Silence[],
  options: CutOptions = DEFAULT_CUT_OPTIONS,
  energy?: Energy,
): Cut[] {
  const first = byId.get(pick.first);
  const range = resolveRange(pick, byId, words);
  if (first === undefined || typeof range === 'string') return [];

  const cuts: Cut[] = [];
  let from = range.start;

  const emit = (to: number): void => {
    const head = words[from];
    const tail = words[to];
    if (head === undefined || tail === undefined) return;
    const before = words.slice(Math.max(0, from - 6), from).map((w) => w.start).reverse();
    const afterStarts = words.slice(to + 1, to + 7).map((w) => w.start);
    const entry = snapIn(head.start, words[from - 1]?.start, silences, options, energy, before);
    const exit = snapOut(tail.start, tail.end, words[to + 1]?.start, silences, durationS, options, energy, afterStarts);
    const unsafe: ('in' | 'out')[] = [];
    if (!entry.safe) unsafe.push('in');
    if (!exit.safe) unsafe.push('out');
    if (exit.atS > entry.atS) {
      cuts.push({
        rush: first.rush,
        inS: entry.atS,
        outS: exit.atS,
        unsafe,
        extended: [entry.extendedWords, exit.extendedWords],
      });
    }
  };

  // Les pauses se mesurent dans le son : chez Deepgram la fin d'un mot est le début du suivant,
  // et l'écart entre deux mots vaut toujours zéro. Une pause plus longue que `maxGapS` entre
  // deux mots gardés devient une coupe, et les deux marges la ramènent à ~0,25 s.
  for (let i = range.start; i < range.end; i += 1) {
    const word = words[i];
    const next = words[i + 1];
    if (word === undefined || next === undefined) continue;
    // Tolérance large vers l'arrière : Deepgram date souvent le mot suivant avant la fin réelle
    // de la pause (23 pauses > 0,5 s restaient dans les prises avec 150 ms, le 2026-10-13).
    // Un silence plus long que `maxGapS` qui commence entre ce mot et le suivant — qu'il touche le
    // mot suivant ou qu'un bruit de bouche le fragmente avant.
    // Et qui commence nettement avant le mot suivant : un mot doux (« an. ») passe sous le seuil
    // et le silence « commence » avec lui — ce n'est pas une pause, c'est le mot. Le couper là le
    // réduisait à un éclat de 50 ms (2026-10-13).
    const pause = silences.find(
      (sil) =>
        sil.startS >= word.start + 0.05 &&
        sil.startS <= next.start - MIN_WORD_S &&
        sil.endS - sil.startS > options.maxGapS,
    );
    if (pause !== undefined) {
      emit(i);
      // On garde une respiration : la sortie recule dans la pause de `gapKeepS`, bornée par sa fin.
      const last = cuts[cuts.length - 1];
      if (last !== undefined) {
        cuts[cuts.length - 1] = { ...last, outS: Math.min(pause.endS, last.outS + options.gapKeepS) };
      }
      from = i + 1;
    }
  }
  emit(range.end);

  return cuts;
}
