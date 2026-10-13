# Installation — à faire exécuter par Claude Code

Ce fichier est écrit pour Claude Code. Si tu es Claude et qu'on t'a demandé d'installer l'outil
de dérush, suis ces étapes dans l'ordre, en vérifiant chaque fois avant d'installer. Demande la
permission avant chaque commande qui installe quelque chose. Ne tape jamais un mot de passe :
si Homebrew ou macOS en demande un, laisse la main à l'utilisateur.

Cible : un Mac (Apple Silicon ou Intel). Tout tient en dix minutes.

## 1. Outils système

Vérifie, puis installe seulement ce qui manque :

- **Homebrew** : `brew --version`. Absent → l'utilisateur l'installe lui-même depuis
  https://brew.sh (la commande demande son mot de passe). Attends qu'il te dise que c'est fait.
- **Node 22 ou plus** : `node --version`. Absent ou plus vieux → `brew install node`.
- **ffmpeg** (avec ffprobe) : `ffmpeg -version`. Absent → `brew install ffmpeg`.
- **git** : `git --version`. Absent → `brew install git`.

## 2. Le dépôt

Si tu n'es pas déjà dans le dépôt (ce fichier à la racine), clone-le dans le dossier courant :

```
git clone https://github.com/<organisation>/yomi-derush
cd yomi-derush
```

Puis les dépendances : `npm install`. Deux avertissements `allow-scripts` (esbuild, fsevents)
sont normaux : n'approuve rien, ça marche sans. Vérifie : `npx tsc --noEmit` ne doit rien
afficher, et `npm test` doit passer.

## 3. La clé Deepgram

L'outil transcrit avec Deepgram (environ 0,30 $ par heure de rush). Il faut une clé :

1. Demande à l'utilisateur s'il a déjà une clé. Sinon : compte sur https://console.deepgram.com
   (des crédits gratuits sont offerts), puis « API Keys » → « Create a New API Key ».
2. Si `.env` existe déjà avec une clé, ne touche à rien. Sinon copie `.env.example` en `.env` et
   demande-lui de coller la clé dans `DEEPGRAM_API_KEY=`.
   Si l'utilisateur te la donne en clair dans la conversation, écris-la dans `.env` sans la
   répéter dans tes réponses, et conseille-lui de la révoquer plus tard si la conversation
   est partagée.
3. `.env` est hors git : vérifie-le avec `git check-ignore .env`.

## 4. Test de bout en bout

Fabrique un extrait de 30 s depuis n'importe quelle vidéo parlée que l'utilisateur a sous la
main (un rush brut de 60 Go convient : `-c copy` ne ré-encode pas, ça prend une seconde) :

```
ffmpeg -y -ss 60 -t 30 -i <video> -c copy /tmp/extrait.mp4
npx tsx src/cli/derush.ts /tmp/extrait.mp4 --name test --out /tmp/derush-test --prepare
```

Tu dois obtenir `/tmp/derush-test/a-trancher.md` avec des phrases numérotées (`A1`, `A2`…).
Écris `/tmp/derush-test/decision.json` qui garde les deux premières :

```json
{ "keep": [{ "first": "A1", "last": "A2", "why": "", "alternates": [] }], "warnings": [], "missing": [] }
```

Puis :

```
npx tsx src/cli/derush.ts /tmp/extrait.mp4 --name test --out /tmp/derush-test --reuse
npx tsx src/cli/check.ts /tmp/derush-test
```

Si `derush.xml` et `controle.md` existent, tout est en place. Sur un test aussi court, un
montage de quelques secondes et une « borne posée sans silence » sont normaux. Dis à
l'utilisateur :

> Prêt. Pour un tournage : ouvre ce dossier dans Claude Code et tape
> `/derush <rush.mp4> --audio <son.wav>`. `--audio` est le wav de l'enregistreur, si le son a
> été pris à part ; sans lui, l'outil utilise le son de la caméra.

## 5. Mises à jour

`git pull` dans le dépôt, puis `npm install`. Les règles de dérush sont dans
`.claude/skills/derush/SKILL.md` et `prompts/derush.md` : elles évoluent avec les retours du
monteur, et un `git pull` suffit à les récupérer.
