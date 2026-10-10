# data/

Put your own Total Annihilation game files here. Everything in this folder except this README is gitignored and must never be committed.

1. Buy Total Annihilation (Commander Pack) on GOG and download the offline Windows installer.
2. `brew install innoextract`
3. `innoextract setup_total_annihilation*.exe`
4. Copy the archives (`*.hpi`, `*.ufo`, `*.ccx`, `*.gp3`) into this folder. (The palette lives inside `totala1.hpi`, so there is no separate `palette.pal` to copy.)

Tests that need real files skip cleanly when they are missing.
