# Scrap Survivor

Enable **Arcade mode** in Settings → Experimental to play while an agent works. Move with the on-screen joystick,
arrow keys, or WASD. Weapons fire automatically. Collect scrap to level up, choose equipment,
and defeat the Warden, which arrives after 150 seconds. Opening the loadout or hangar pauses play and
shows equipment levels and evolution requirements.

You have three weapon slots, including your robot's starting weapon. Choose among bolts,
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
reward choices save locally in this browser. Older saves migrate automatically.

## Between expeditions

Open **Hangar** to inspect robots, choose the next sector and starting weapon, or buy workshop
upgrades. During an active expedition, these choices apply to the next launch; **Resume expedition**
continues the current loadout. **End current expedition** asks before returning with recovered
salvage. A completed expedition shows its rewards before the next launch.

| Sector | Mission and conditions |
| --- | --- |
| 1 · Scrapyard | Defeat the Warden. One optional relay provides bonus salvage. |
| 2 · Foundry | Restore one relay and defeat the Warden. More chargers and sentries, tougher enemies, and marked heat vents. |
| 3 · Stormworks | Restore two relays and defeat the Warden. Denser sentry patrols, faster and wider volleys, and twin storm strikes. |

Clearing the highest available sector unlocks the next. Earlier sectors remain replayable.
Relays change position with the expedition seed. Follow the HUD direction arrow and stay inside
the marked circle for five accumulated seconds. Progress remains when you move away. Each restored
relay gives 20 scrap XP and repairs 1 HP. Later-sector victory requires both the Warden and relay
objectives, in either order. Hazards mark their area for 1.5 seconds before becoming damaging.

Salvage is earned from kills (one part per five enemies), elites (six parts each), and relays
(ten parts each). Victory secures it all plus 25 parts per sector level. Defeat or a voluntary
return keeps half of earned salvage, rounded down; ending an empty run gives no reward.
The salvage workshop bonus applies after this calculation. Rewards and the completed run are
saved together, so reopening or reloading the result does not award it again.

| Robot | Unlock | Starting weapon and tradeoff | Mastered trait |
| --- | --- | --- | --- |
| Scout | Available immediately | Bolts; 8 HP, fast movement and wider scrap pickup | Another 25 pickup range |
| Bulwark | Recover 40 lifetime parts | Blades; 11 HP but slower movement | Equipment upgrades repair 1 additional HP |
| Engineer | Recover 100 lifetime parts | Drones; 7 HP, +25% drone and mine damage | One extra support drone and another 25% mine damage multiplier |

Spending parts never reduces lifetime unlock progress. Each robot earns its own mastery from
kills (one per ten), elites (four each), relays (six each) and victories (twenty). Defeat or
retreat retains all earned mastery. At 30 mastery, Scout unlocks a lightning starter, Bulwark
unlocks bolts, and Engineer unlocks mines. At 90 mastery, its mastered trait becomes active
on the next launch.

Workshop upgrades are shared by all robots and apply on the next launch. Each has three levels,
costing 20, 40 and 60 parts: **Hull plating** adds 1 maximum HP per level, **Weapon tuning** adds
8% weapon damage per level, and **Salvage rig** adds 10% recovered parts per level. These caps keep
sector selection and equipment choices relevant. The initial campaign has three sectors;
after the final sector, all sectors can be replayed with other robots and starter weapons.

Campaign progress and the active expedition are local to this browser. There is no account-wide
progression or cross-device save sync. Clearing browser data removes both. A save failure keeps
the in-tab snapshot and displays a warning; keep the tab open until saving is available again.
The first campaign save imports the previous run. It uses separate storage from older clients,
so a tab still running an older game cannot overwrite campaign progress with a run-only save.

The game pauses when the tab loses focus or message delivery needs attention. A final agent
reply or a new input/approval request returns you to chat; progress messages keep play open.
Reopen the game to continue the saved run. Your chat draft remains in place.

## Module boundaries and checks

The game lives in `apps/web/src/games/scrap-survivor`. Its `rules/` directory contains deterministic
combat, campaign rewards and unlocks, equipment definitions, and save validation. `engine.ts` is the pure rules
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
