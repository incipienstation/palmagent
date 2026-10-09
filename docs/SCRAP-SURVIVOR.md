# Scrap Survivor

Enable **ADHD mode** in Settings to play while an agent works. Move with the on-screen joystick,
arrow keys, or WASD. Weapons fire automatically. Collect scrap to level up, choose equipment,
and defeat the Warden, which arrives after 150 seconds. Opening the loadout pauses play and
shows equipment levels and evolution requirements.

You have three weapon slots, including the starting Bolt launcher. Choose among bolts,
orbiting blades, chain lightning, proximity mines, and support drones. Reactor, magnet, and
tread supports use no weapon slots. Weapons reach level 5; supports reach level 3.
Mines reward leading enemies across your trail; drones add mobile ranged fire.

Elite sentinels arrive at 55 and 105 seconds. Each drops a chest when defeated. Approach the
chest to pause and choose one reward. A weapon at level 5 plus its matching support at level 1
or higher unlocks an evolution in that chest:

| Weapon | Support | Evolution |
| --- | --- | --- |
| Bolt launcher | Overcharged core | Reactor railgun: a long piercing beam |
| Orbiting blades | Scrap magnet | Magnetic grinder: a wider cutter ring that pulls enemies in |
| Chain lightning | Turbo treads | Storm relay: lightning impacts release nearby shockwaves |

Chests also offer owned equipment upgrades or hull repair when space permits. You can leave a
chest on the ground until your components are ready. Progress, equipment, mines, and unclaimed
reward choices save locally in this browser. Older saves migrate automatically. There is no
account-wide progression or cross-device save sync.

The game pauses when the tab loses focus or message delivery needs attention. A final agent
reply or a new input/approval request returns you to chat; progress messages keep play open.
Reopen the game to continue the saved run. Your chat draft remains in place.

## Module boundaries and checks

The game lives in `apps/web/src/games/scrap-survivor`. Its `rules/` directory contains deterministic
combat, progression, equipment definitions, and save validation. `engine.ts` is the pure rules
entry point; `scene.ts` and `combat-art.ts` render the run in Phaser. `useGameSession.ts` owns input,
pause, and save timing through a storage interface. `SurvivorGame.tsx` presents the game UI.

The surrounding `games/SurvivorSheet.tsx` owns Palmagent status and chat controls. It and the browser
storage adapter consume `scrap-survivor/api.ts`; game rules know nothing about agent tasks or
browser storage. Phaser remains dynamically loaded when play is requested.

Run the rules suite without building the app or starting a browser:

```sh
node apps/web/scripts/test-game.mjs
```

The regular web verification runner includes these tests before browser checks. The browser suite
also covers movement, focus, delivery state, chat return, reload, rewards, and short screens.
