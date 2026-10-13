# yomi-derush

Dérush automatique d'un tournage face caméra, livré en séquence Premiere Pro. Pensé pour être
piloté par Claude Code : le monteur tape `/derush`, Claude fait le reste.

## Pour le monteur

1. Installe [Claude Code](https://claude.com/claude-code) et connecte-toi avec ton compte.
2. Ouvre un dossier vide dans Claude Code et colle :

   > Installe l'outil de dérush depuis https://github.com/loris-arch/yomi-derush — suis INSTALL.md.

   Claude installe ce qu'il faut et te demande une clé Deepgram (gratuite à créer, ~0,30 $ par
   heure de rush).
3. À chaque tournage, dépose le rush et le wav de l'enregistreur dans un dossier, ouvre le
   dépôt `yomi-derush` dans Claude Code et tape :

   ```
   /derush /chemin/vers/C0055.MP4 --audio "/chemin/vers/Stereo Mix.wav"
   ```

   Dix à vingt minutes plus tard, tu as dans `derush/` à côté du rush : `derush.xml` (Fichier >
   Importer dans Premiere), `controle-audio.m4a` (à écouter), `rapport.md` (ce qu'il faut
   vérifier).

## Ce que ça fait

- Synchronise le son de l'enregistreur sur la caméra (décalage et dérive d'horloge), et l'utilise
  pour tout : coupes, transcription, pistes audio du XML.
- Transcrit mot à mot (Deepgram), découpe en phrases numérotées.
- Claude lit le transcript et choisit les prises : par point, sur la logique, la cohérence et
  le français ; reformulations réduites à la dernière ; consignes à l'équipe appliquées puis
  coupées ; ordre du script.
- Pose les coupes sur les silences mesurés dans le son, collées à la voix, sans fondu ; ramène
  les pauses internes > 0,6 s à 0,3 s.
- Contrôle : rend l'audio du montage, le retranscrit, compte les mots doublés et les coupes en
  pleine voix, et relit le texte entier pour le sens. Corrige, recommence.
- Livre un XML FCP7 (image sur le rush, son sur le wav synchronisé) avec des marqueurs
  `COUPE-VOIX`, `A-VERIFIER`, `AUTRE-PRISE`, plus une séquence « autres prises ».

## Commandes

```
npx tsx src/cli/derush.ts <rush> [--audio <wav>] [--script <txt>] [--name <nom>] [--out <dossier>] --prepare
npx tsx src/cli/derush.ts <rush> [...mêmes options] --reuse
npx tsx src/cli/check.ts <dossier de sortie>
npm test
```

Options de coupe : `--pad-start` (défaut 0,02 s), `--pad-end` (0,03 s), `--max-gap` (0,6 s ;
`0` = ne jamais resserrer).

## Ce qui rend le dérush facile, au tournage

Une pause de deux ou trois secondes avant de reprendre, la phrase entière reprise (jamais au
milieu), et un seul fichier par discours. C'est ce qui réduit le plus les coupes en pleine voix.
