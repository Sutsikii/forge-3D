# Forge3D Studio

Studio desktop local (Tauri 2 + Rust + React/three.js) pour exploiter Hunyuan3D 2.1 :
image → 3D, texte → 3D, texture PBR sur n'importe quel maillage, file d'attente, bibliothèque, exports.

## Architecture

| Couche | Rôle |
|---|---|
| `src-tauri/` (Rust) | Installeur du runtime (uv → Python 3.10 → code Hunyuan figé → torch cu124 → deps → extensions natives → vérif), supervision du backend, réglages, détection GPU/CUDA/MSVC |
| `backend/` (Python, FastAPI) | Moteur sur 127.0.0.1:47823 : file GPU unique, gestion VRAM par profil, progression réelle (tqdm intercepté), annulation, bibliothèque, téléchargement des modèles, exports |
| `src/` (React) | Créer · Texturer · File d'attente · Bibliothèque · Modèles · Réglages + viewer three.js (PBR / argile / filaire / normales / UV) |

## Dev

```sh
npm install
npm run tauri dev          # app
npx tauri build            # installeur NSIS
forge3d.exe --install [--force] [--only uv,python,code,torch,deps,native,verify]   # install sans UI
```

## Texture PBR : prérequis

`custom_rasterizer` (CUDA) se compile avec le CUDA Toolkit 12.x + MSVC.
Puis Réglages → Moteur → « Recompiler les extensions ».

## Licence des modèles

Hunyuan3D 2.1 : Tencent Hunyuan Community License, qui **exclut l'UE, le Royaume-Uni et la Corée du Sud**.
