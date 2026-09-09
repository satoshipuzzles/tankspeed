# TankSpeed

Kart racing with tanks, on Nostr. Mario-Kart-style: drop bananas, fire shells,
three laps, don't be last. Built in the same visual language as
[nostr-tank-arena](https://github.com/satoshipuzzles/nostr-tank-arena) — the
same tank silhouette, the same hue-from-pubkey identity rule, and the same skin
catalog, so a skin earned in one game is a skin worn in all of them.

## Play

- **Desktop:** WASD / arrows to drive, space to use your item.
- **Mobile:** auto-gas; steer with the pads, tap the button to use your item.

Pick a track, hit RACE, beat five rival tanks over three laps. Item boxes give
you a banana (drop it behind you) or a shell (fires down the racing line).

## Roadmap

Part of the HODLAND family of Nostr mini-games. Coming next, roughly in order:

1. NIP-07 / bunker login, profile editing, and the shared skin picker
2. Lobby with share links; host sets a start **block height** and the race
   starts when the chain reaches it
3. Nostr multiplayer + matchmaking
4. Tank studio and more maps

## Develop

```sh
npm install
npm run dev        # http://localhost:4460
npm run build      # typecheck + bundle to dist/
npm run preview    # serve dist/ on 4460
npm run test:race  # headless-Chrome race test against the preview server
```

The race test drives a real race with an autopilot and fails if the tank does
not move, laps are not counted, items never appear, or the canvas is not
painting. Screenshots land in `.scratch/shots/`.
