# TA Engine

A clean-room, Mac-native reimplementation of Total Annihilation that plays on your own copy of the original game data. No Cavedog assets are included. See `PLAN.md` for the roadmap and `data/README.md` for getting the game files.

```sh
npm install
npm run dev    # http://localhost:5173
npm test
npm run ta -- fbi ARMCOM   # print a unit's definition as JSON
```

With the dev server running, http://localhost:5173/archives.html browses every file in your archives http://localhost:5173/models.html shows any unit in 3D, http://localhost:5173/maps.html lets you fly over any map, and http://localhost:5173/game.html is a skirmish against the computer (easy, medium or hard).
