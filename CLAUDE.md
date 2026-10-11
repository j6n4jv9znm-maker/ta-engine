# TA Engine

A clean-room, Mac-native reimplementation of Total Annihilation (single-player skirmish vs AI) that runs on the user's own original game data. The full plan lives in `PLAN.md`.

## Hard rules
- **Never commit game data.** `data/` is gitignored (only `data/README.md` is tracked). The engine never ships Cavedog assets.
- **Tests that need real files skip cleanly** when `data/` is missing. Use `describe.skipIf(!hasGameData())` from `src/testData.ts`.
- **Every parser gets unit tests against real files plus a small debug viewer page.**
- **Simulation stays separate from rendering.** The sim is a fixed-timestep (30 Hz), deterministic loop with seeded RNG; the renderer only reads sim state. Never mix the two, and never let rendering code mutate sim state.
- **One phase at a time.** Don't start a phase until the previous phase's milestone works.
- **Clean-room only.** Never decompile or copy code from the original executable. When a format detail is uncertain, check community documentation and open-source readers (RWE, TA3D, Scriptor) instead of guessing.

## Stack
TypeScript (strict) + Vite + Three.js (WebGL) in the browser for development, Vitest for tests, Tauri for the final `.app` (Phase 9). Only move the sim core to Rust/WASM if performance actually demands it.

## Commands
- `npm run dev`: Vite dev server on http://localhost:5173
- `npm test`: run Vitest once (`npm run test:watch` to watch)
- `npm run typecheck`: TypeScript check
- `npm run build`: typecheck and production build
- `npm run ta -- <command>`: data CLI (`archives`, `ls`, `extract`, `cat`, `tdf`, `fbi ARMCOM`, `units`, `palette`); extracted files go to the gitignored `extracted/`
- Debug pages (dev server): http://localhost:5173/archives.html (files, FBI JSON, GAF sprites), http://localhost:5173/models.html (unit model viewer; runs unit scripts: walk, aim, fire, build, open, die), http://localhost:5173/maps.html (map viewer), http://localhost:5173/game.html (sandbox: start with a Commander, build a base and an army, move units)

## Layout
- `src/`: engine source (`main.ts` is the browser entry)
  - `formats/`: file-format parsers (HPI archives, TDF text, palette, GAF sprites, 3DO models, TNT maps, OTA map settings, COB unit scripts)
  - `sim/`: simulation (deterministic, 30 Hz, no rendering): seeded RNG, piece animation, COB unit-script VM (`sim/cob/`), per-unit script runner, unit definitions, terrain movement rules, A* pathfinding, economy (`economy.ts`), build menus, and `world.ts` (the game loop: units, commands, tasks, steering, collisions, building, factories, reclaiming)
  - `map/`: renderer-independent map data (features, placed features, heights); world units are TA pixels from the map's top-left
  - `graphics/`: renderer-side code (textures, model geometry, Three.js model builder, terrain, feature sprites, RTS camera, posing models from sim piece state, drawing sim units)
  - `io/`: byte sources for Node, browser files and the dev server
  - `vfs.ts`: layers archives in TA's load order (.hpi < .ufo < .ccx < .gpf < .gp3)
  - `debug/`: debug viewer pages
- `tools/`: command-line tools (`ta.ts`)
- `test/`: Vitest tests
- `data/`: your local game files, gitignored
