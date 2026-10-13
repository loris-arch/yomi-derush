"""Transcrit un fichier audio ou vidéo en local avec Whisper (MLX, puce Apple), au mot près.

Appelé par `pnpm derush` : imprime sur stdout un JSON { words, durationS }, chaque mot portant
son début et sa fin en secondes. Gratuit et hors ligne, une fois le modèle téléchargé au
premier appel (~1,6 Go, gardé dans le cache Hugging Face).

`condition_on_previous_text=False` : sans lui, Whisper recopie sa phrase précédente sur les
longs blancs d'un rush — exactement là où un tournage en a le plus.
"""

import json
import sys

import mlx_whisper

MODEL = "mlx-community/whisper-large-v3-turbo"

result = mlx_whisper.transcribe(
    sys.argv[1],
    path_or_hf_repo=MODEL,
    language="fr",
    word_timestamps=True,
    condition_on_previous_text=False,
    verbose=None,
)

words = [
    {"w": w["word"].strip(), "start": round(w["start"], 3), "end": round(w["end"], 3), "speaker": 0}
    for segment in result["segments"]
    for w in segment.get("words", [])
    if w["word"].strip() != ""
]
duration = max((s["end"] for s in result["segments"]), default=0.0)
json.dump({"words": words, "durationS": duration}, sys.stdout, ensure_ascii=False)
