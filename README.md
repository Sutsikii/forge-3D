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

## MCP et Unity

Le moteur expose un serveur **MCP** (transport HTTP) sur `http://127.0.0.1:47823/mcp` : un assistant
compatible peut générer des modèles, suivre la file, parcourir la bibliothèque et les placer dans Unity.

```json
{ "mcpServers": { "forge3d": { "type": "http", "url": "http://127.0.0.1:47823/mcp" } } }
```

Outils : `forge_status`, `forge_generate`, `forge_texture`, `forge_job`, `forge_cancel`, `forge_library`,
`forge_item`, `forge_export`, `unity_status`, `unity_scene`, `unity_import`, `unity_create`,
`unity_transform`, `unity_delete`, `unity_screenshot`, `unity_save_scene`.

Côté Unity (2022.3+), installe le pont via Package Manager → *Add package from git URL* :

```
https://github.com/Sutsikii/forge-3D.git?path=/unity/com.forge3d.bridge
```

Il écoute sur `127.0.0.1:47824` dès l'ouverture de l'éditeur et installe glTFast au premier import GLB.
La bibliothèque de l'app propose aussi un bouton **Unity** pour envoyer un modèle dans la scène ouverte.

## Texture PBR : prérequis

`custom_rasterizer` (CUDA) se compile avec le CUDA Toolkit 12.x + MSVC.
Puis Réglages → Moteur → « Recompiler les extensions ».

## Licence des modèles

Hunyuan3D 2.1 : Tencent Hunyuan Community License, qui **exclut l'UE, le Royaume-Uni et la Corée du Sud**.
