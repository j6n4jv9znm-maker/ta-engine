# TA Engine: Mac-native Total Annihilation reimplementation

## Goal
Play Total Annihilation (single-player skirmish vs AI) natively on macOS, using the original game data from the user's own GOG copy. We write a new engine from scratch. The engine never ships with Cavedog assets.

## Non-goals (v1)
- Multiplayer and netcode
- The campaign and its briefings
- Pixel-perfect replication of the original renderer
- Decompiling or copying code from the original executable (clean-room only)

## Hard rules for Claude Code
- Never commit game data. `data/` is gitignored. Tests that need real files skip cleanly if `data/` is missing.
- Every parser gets unit tests against real files plus a small debug viewer page.
- The simulation stays separate from rendering: a fixed-timestep, deterministic sim with the renderer reading its state. Never mix the two.
- Build one phase at a time. Don't start a phase until the previous milestone works.
- When a format detail is uncertain, check community documentation and existing open-source readers (see References) instead of guessing.

## Stack
- **TypeScript + Vite + Three.js (WebGL)**, running in the browser during development. Iteration is fast and Claude Code is fluent in it.
- **Vitest** for tests.
- **Tauri** wraps it as a real `.app` at the end (Phase 9).
- Fallback: if sim performance becomes a problem with large armies, move the sim core to Rust compiled to WASM. Don't do this pre-emptively.

## Getting the data (Phase 0)
1. Buy TA (Commander Pack) on GOG and download the offline Windows installer.
2. `brew install innoextract`, then `innoextract setup_total_annihilation*.exe` to unpack it on the Mac without Windows.
3. Copy the archives (`*.hpi`, `*.ufo`, `*.ccx`, `*.gp3`) and `palette.pal` into `data/`.

## Phases and milestones

### Phase 0: Setup
Repo scaffold, Vite dev server, Vitest, `.gitignore` for `data/`, and a `CLAUDE.md` restating the hard rules.
**Milestone:** empty app runs; tests run.

### Phase 1: Archives and text formats
- HPI archive reader (header key, XOR decryption, chunked LZ77/zlib decompression, directory tree). It also covers UFO/CCX/GP3, which use the same format.
- A virtual filesystem that layers archives in the original load order (later archives override earlier ones).
- TDF/FBI/OTA parser (the bracketed text format used for unit, weapon, and map definitions).
- Palette loading.
**Milestone:** a CLI and a web page that list and extract any file, and display any unit's FBI as JSON.

### Phase 2: Graphics assets
- GAF decoder (palettized sprites and textures, including multi-frame animations) to RGBA.
- 3DO model loader (piece hierarchy, vertices, polygons, texture references, named pieces).
- Team colors.
**Milestone:** a model viewer where you can pick any unit and rotate it, fully textured.

### Phase 3: Maps
- TNT loader: tile graphics, heightmap, feature placement (trees, rocks, wrecks).
- OTA loader: map metadata and start positions.
- Terrain mesh from the heightmap, minimap, and an RTS camera (pan, zoom, edge scroll).
**Milestone:** fly over any original map with features shown.

### Phase 4: Unit scripts (COB)
- COB bytecode interpreter: a stack VM with the opcodes for move, turn, spin, show/hide, explode, sleep, wait-for, signal, and start-script.
- Multiple concurrent script threads per unit, driven by sim ticks.
- Hook up standard entry points such as Create, StartMoving/StopMoving, Activate, AimPrimary/FirePrimary, and Killed.
**Milestone:** in the model viewer, units animate correctly when you trigger walk, aim, build, and death.

### Phase 5: Simulation core
- Fixed-timestep sim loop (30 Hz, matching the original), entity system, and seeded RNG.
- Unit placement, selection (click and box), and move/stop commands.
- Ground movement with acceleration, turn rate, and slope limits from the FBI.
- Pathfinding: A* on the terrain grid first, upgrading to flow fields for group moves later.
- Air units and hovercraft can come later in this phase; start with ground.
**Milestone:** select a group of units and move them around a real map without them getting stuck.

### Phase 6: Economy and construction
- Metal and energy: production, storage, and spending, including the stalling behavior when you over-spend.
- Metal extraction from map spots, plus wind, solar, and tidal energy.
- Build menus driven by FBI/GUI data, construction with the nano-lathe effect, build queues, factories, and rally points.
- Reclaiming wreckage and features.
**Milestone:** start with a Commander and build a working base and an army.

### Phase 7: Combat
- Weapons from TDF: lasers, ballistic cannons, missiles, and beams, with range, reload, accuracy, and damage.
- Real projectile physics, since TA hits or misses based on the projectile's actual flight path.
- Health, armor, death explosions, wreckage, and Commander death explosions.
- Line of sight, radar, and fog of war.
**Milestone:** a full fight between two hand-controlled armies.

### Phase 8: Skirmish AI
- A simple rule-based AI: expand the economy, build factories, build an army, and attack in waves.
- Difficulty levels by tuning those rules.
**Milestone:** a complete skirmish game against the AI from start to victory or defeat.

### Phase 9: Polish and packaging
- Sound effects and music from the original data.
- The in-game UI (build menu, resource bar, selected-unit info) and a game setup screen.
- Save and load (easy because the sim is deterministic and separate).
- Package as a Mac app with Tauri, prompting for the TA folder on first launch.
**Milestone:** double-click an app and play TA.

## Rough effort
Phases 1–3 are very doable in a few weekends. Phase 4 (COB) is the first real technical hurdle. Phases 5–7 are the bulk of the work, where it starts to feel like the game. Phase 8 can stay simple for a long time.

## References (verify before relying on them)
- Community format docs for HPI, 3DO, COB, GAF, and TNT, widely mirrored from the old TA modding sites.
- **RWE (Robot War Engine)** on GitHub: an open-source TA engine reimplementation in C++ that loads original data. It's the best reference for format edge cases and behavior.
- **TA3D**: an older open-source TA engine.
- Scriptor and other BOS/COB tools for understanding unit scripts.
