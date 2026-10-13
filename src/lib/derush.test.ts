import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { TranscriptWord } from './transcript.js';

import { checkPick, joinWords, pickToCuts, resolveRange, rushLetter, splitPhrases } from './derush.js';
import { buildXmeml, pathUrl, rateOf, toFrames } from './xmeml.js';

function words(spec: readonly [string, number, number][]): TranscriptWord[] {
  return spec.map(([w, start, end]) => ({ w, start, end, speaker: 0 }));
}

// Un faux départ, une pause, la bonne prise, puis une seconde phrase après un long blanc.
const RUSH = words([
  ['Le', 0.0, 0.2],
  ['dropshipping', 0.25, 0.8],
  ['Le', 1.6, 1.8],
  ['dropshipping,', 1.85, 2.4],
  ['c’est', 2.45, 2.6],
  ['simple.', 2.65, 3.1],
  ['Vraiment', 3.2, 3.6],
  ['simple.', 5.0, 5.4],
]);

describe('splitPhrases', () => {
  it('coupe sur la ponctuation et sur une pause, numérote par rush', () => {
    const phrases = splitPhrases(RUSH, 1);
    assert.deepEqual(
      phrases.map((p) => [p.id, p.text]),
      [
        ['B1', 'Le dropshipping'],
        ['B2', 'Le dropshipping, c’est simple.'],
        ['B3', 'Vraiment'],
        ['B4', 'simple.'],
      ],
    );
    assert.equal(phrases[1]?.gapBeforeS.toFixed(1), '0.8');
  });

  it('nomme les rushes au-delà de Z', () => {
    assert.equal(rushLetter(0), 'A');
    assert.equal(rushLetter(25), 'Z');
    assert.equal(rushLetter(26), 'AA');
  });
});

describe('pickToCuts', () => {
  const phrases = splitPhrases(RUSH, 0);
  const byId = new Map(phrases.map((p) => [p.id, p] as const));
  const options = { padStartS: 0.08, padEndS: 0.15, maxGapS: 1.0, gapKeepS: 0, snapS: 0.6, extendS: 0, extendMaxWords: 0 };
  // Silences mesurés : entre le faux départ et la reprise, puis le long blanc avant « simple ».
  const silences = [
    { startS: 0.85, endS: 1.55 },
    { startS: 3.65, endS: 4.95 },
  ];

  it('pose l’entrée dans le silence qui précède, avec sa marge', () => {
    const [cut] = pickToCuts({ first: 'A2', last: 'A2' }, byId, RUSH, 10, silences, options);
    // Silence [0,85 ; 1,55], mot à 1,6 : entrée à 1,55 − 0,08.
    assert.equal(cut?.inS.toFixed(2), '1.47');
    assert.deepEqual(cut?.unsafe, ['out']);
  });

  it('pose la sortie dans le silence qui suit et retire un blanc trop long', () => {
    const cuts = pickToCuts({ first: 'A2', last: 'A4' }, byId, RUSH, 10, silences, options);
    assert.equal(cuts.length, 2);
    // « Vraiment » finit à 3,6, silence à 3,65 : sortie à 3,65 + 0,15.
    assert.equal(cuts[0]?.outS.toFixed(2), '3.80');
    assert.deepEqual(cuts[0]?.unsafe, []);
    // Reprise sur « simple. » à 5,0 : entrée à 4,95 − 0,08.
    assert.equal(cuts[1]?.inS.toFixed(2), '4.87');
  });

  it('signale une borne sans silence au lieu de la poser dans le mot voisin', () => {
    // Entre « simple. » (3,1) et « Vraiment » (3,2) : aucun silence, Yomi enchaîne.
    const [cut] = pickToCuts({ first: 'A2', last: 'A2' }, byId, RUSH, 10, silences, options);
    assert.ok(cut !== undefined && cut.outS <= 3.2 && cut.outS >= 3.1);
  });

  it('ne cale jamais une entrée sur un silence qui engloberait le mot précédent', () => {
    const inside = [{ startS: 0.1, endS: 1.55 }];
    const [cut] = pickToCuts({ first: 'A2', last: 'A2' }, byId, RUSH, 10, inside, options);
    assert.deepEqual(cut?.unsafe, ['in', 'out']);
  });

  it('refuse une plage à l’envers ou inconnue', () => {
    assert.match(checkPick({ first: 'A3', last: 'A2' }, byId) ?? '', /à l'envers/);
    assert.match(checkPick({ first: 'A9', last: 'A9' }, byId) ?? '', /n'est pas un numéro/);
    assert.equal(checkPick({ first: 'A1', last: 'A4' }, byId), null);
  });
});

describe('resolveRange', () => {
  // Une reprise sans pause : la phrase entière contient la prise ratée et la bonne.
  const RETAKE = words([
    ['Une', 0.0, 0.2],
    ['fois', 0.2, 0.4],
    ['que', 0.4, 0.5],
    ['vous', 0.5, 0.6],
    ['l', 0.6, 0.65],
    ["'avez,", 0.65, 0.9],
    ['une', 1.0, 1.1],
    ['fois', 1.1, 1.3],
    ['que', 1.3, 1.4],
    ['vous', 1.4, 1.5],
    ['l', 1.5, 1.55],
    ["'avez,", 1.55, 1.8],
    ['postulez.', 1.9, 2.4],
  ]);
  const phrases = splitPhrases(RETAKE, 0);
  const byId = new Map(phrases.map((p) => [p.id, p] as const));

  it('recolle les apostrophes de Whisper', () => {
    assert.equal(joinWords(RETAKE.slice(0, 6)), "Une fois que vous l'avez,");
  });

  it('démarre sur la dernière occurrence citée, accents et ponctuation ignorés', () => {
    assert.deepEqual(resolveRange({ first: 'A1', last: 'A1', from: "Une fois que vous l'avez" }, byId, RETAKE), {
      start: 6,
      end: 12,
    });
  });

  it('finit sur la citation de fin', () => {
    assert.deepEqual(resolveRange({ first: 'A1', last: 'A1', to: "vous l'avez" }, byId, RETAKE), { start: 0, end: 5 });
  });

  it('refuse une citation absente', () => {
    assert.match(checkPick({ first: 'A1', last: 'A1', from: 'postuler' }, byId, RETAKE) ?? '', /n'apparaît pas/);
  });
});

describe('buildXmeml', () => {
  it('écrit 29,97 en timebase 30 NTSC', () => {
    const rate = rateOf(30000 / 1001);
    assert.deepEqual([rate.timebase, rate.ntsc], [30, true]);
    assert.equal(toFrames(10, rate), 300);
    assert.deepEqual([rateOf(25).timebase, rateOf(25).ntsc], [25, false]);
  });

  it('encode les chemins et ne déclare chaque fichier qu’une fois', () => {
    assert.equal(pathUrl('/Volumes/Rush 01/é.mov'), 'file://localhost/Volumes/Rush%2001/%C3%A9.mov');

    const media = [
      { path: '/r/a.mov', durationS: 60, width: 1920, height: 1080, fps: 25, audioChannels: 2, sampleRate: 48000 },
    ];
    const xml = buildXmeml('Test', media, [
      {
        name: 'Seq',
        clips: [
          { media: 0, inS: 1, outS: 2, name: '#1' },
          { media: 0, inS: 5, outS: 7, name: '#2' },
        ],
        markers: [{ atS: 1, name: 'M', comment: 'a & b' }],
      },
    ]);
    assert.equal(xml.match(/<pathurl>/g)?.length, 1);
    // 1 clip vidéo + 2 pistes audio, deux fois.
    assert.equal(xml.match(/<clipitem /g)?.length, 6);
    assert.match(xml, /<start>25<\/start><end>75<\/end><in>125<\/in><out>175<\/out>/);
    assert.match(xml, /<comment>a &amp; b<\/comment><in>25<\/in>/);
  });
});
