---
name: derush
description: Dérush automatique d'un tournage face caméra (rush vidéo + enregistrement audio séparé) livré en séquence Premiere Pro. À utiliser quand le monteur demande un dérush, un premier montage, de nettoyer les reprises d'un rush, ou tape /derush.
---

# Dérush d'un tournage

Tu produis le **premier montage propre** d'un tournage : les prises ratées, les reprises, les
blancs et les consignes à l'équipe sont retirés ; le propos reste entier, dans l'ordre. Le
monteur reçoit un XML à importer dans Premiere, un audio de contrôle à écouter, et un rapport.

Arguments attendus : le rush vidéo, et si possible `--audio <wav>` (l'enregistreur) et
`--script <fichier>` (le texte prévu). Sans `--audio`, le son de la caméra sert, en moins bon.

Tout se lance depuis la racine de ce dépôt. Les commandes sont `npx tsx src/cli/derush.ts` et
`npx tsx src/cli/check.ts`. Le dossier de sortie est `<dossier du rush>/derush` sauf `--out`.

## 1. Préparer

```
npx tsx src/cli/derush.ts <rush.mp4> --audio <son.wav> --name <nom> --prepare
```

Ça synchronise le son séparé sur la caméra (corrélation, dérive corrigée), transcrit avec
Deepgram (mot à mot : les reprises restent visibles, c'est voulu), mesure les silences, et écrit
`a-trancher.md` : la consigne de choix des prises, puis le transcript en phrases numérotées
(`A1`, `A2`…) avec les blancs indiqués.

Si la corrélation est refusée (« ne correspond pas au son »), le wav n'est pas celui de ce
rush : demande au monteur.

## 2. Choisir les prises

Lis `a-trancher.md` **en entier**. La consigne en tête fait foi ; les points qui comptent le
plus, appris sur de vrais tournages :

- **Par point du discours, lis toutes les prises ensemble** et choisis sur la qualité : logique
  (l'idée est complète), cohérence avec ce qui précède et suit (même personne, mêmes chiffres,
  même tutoiement), français correct. Assemble plusieurs prises si aucune ne tient seule. La
  dernière prise ne sert qu'à départager.
- **Quand la personne se reformule dans la même prise**, garde la dernière formulation seulement
  (« qui peuvent vous permettre, qui vous garantissent » → « qui vous garantissent »). Un
  bafouillage s'entend bien plus qu'une coupe sèche.
- **Mais ne coupe pas juste avant le dernier mot d'une reprise sans pause** : « rajouter
  peut-être que les, rajouter quelques effets » → garde « rajouter quelques effets » entier,
  pas « effets » seul, sinon l'entrée tombe en pleine voix et mange l'attaque.
- **Les consignes dites à l'équipe** (« ça, il faut le mettre plus tôt », « on enlève ça », « on
  commence par le premier job ») sont **appliquées** au montage, puis coupées.
- **L'ordre final est celui du script** (ou du propos), pas celui du tournage.
- Les chiffres, noms propres et plateformes mal transcrits vont dans `warnings`, pas dans le
  texte.

Écris `decision.json` dans le dossier de sortie, au format rappelé dans `a-trancher.md`. Pour
couper à l'intérieur d'une phrase, cite les mots (`from`, `to`) : jamais de secondes.

## 3. Fabriquer

```
npx tsx src/cli/derush.ts <rush.mp4> --audio <son.wav> --name <nom> --reuse
```

Si la commande refuse `decision.json` (numéro inconnu, citation introuvable), corrige et relance.
Elle écrit `derush.xml`, `rapport.md`, `cuts.json`.

## 4. Contrôler, et recommencer

```
npx tsx src/cli/check.ts <dossier de sortie>
```

Lis `controle.md` en entier :

- **Le texte du montage coupe par coupe** : c'est la relecture qui compte. Cherche une idée dite
  deux fois avec d'autres mots, un début de mot mangé (« Vous former » pour « Pour vous
  former »), un bout de phrase voisine qui est rentré (« ça peut | être »), une phrase laissée
  en l'air. Chaque défaut se corrige dans `decision.json` (autre prise, `from`/`to` déplacés,
  plage fusionnée), puis retour à l'étape 3.
- **Bigrammes répétés à cheval sur une coupe** : vérifie chacun. « 20 youtubeurs | pour ces 20
  youtubeurs » est voulu ; « je peux commencer | je peux commencer » ne l'est pas.
- **Coupes à 0 ou 1 mot** : un mot coupé en deux, à corriger.
- **Bornes en pleine voix** : ce sont des reprises sans respiration. Tu ne les élimineras pas
  toutes ; si une alternative existe (une prise avec une pause), prends-la.

Trois tours suffisent en général. Arrête quand le texte se lit d'un trait et que les compteurs
ne bougent plus ; ne force pas un quatrième tour pour un compteur.

Écoute n'est pas possible pour toi : dis-le au monteur, et pointe-lui `controle-audio.m4a` et
les marqueurs `COUPE-VOIX` à écouter en priorité.

## 5. Livrer

Dans le dossier de sortie : `derush.xml`, `audio/<rush>.sync.wav`, `rapport.md`,
`controle-audio.m4a`, `controle.md`. Explique au monteur en quelques lignes :

- Premiere : Fichier > Importer > `derush.xml`. Image sur le rush, son sur le wav synchronisé.
  Coupes sèches, sans fondu : c'est voulu ; un fondu de 2 images là où un raccord claque.
- Les marqueurs : `COUPE-VOIX` (coupe en pleine parole, à écouter), `A-VERIFIER` (chiffre ou
  nom douteux, détail dans `rapport.md`), `AUTRE-PRISE` (une autre prise existe dans la
  séquence « autres prises »).
- La durée avant / après, et les points du rapport qui demandent une décision éditoriale (un
  chiffre qui diffère entre deux prises, un passage jamais dit proprement).

## Réglages

Dans `src/lib/derush.ts`, `DEFAULT_CUT_OPTIONS`. Par défaut : coupe collée à la voix (20 ms
avant, 30 ms après), pauses internes > 0,6 s ramenées à 0,3 s, pas de fondu. Options en ligne :
`--pad-start`, `--pad-end`, `--max-gap`. Ne change les défauts que si le monteur le demande.
