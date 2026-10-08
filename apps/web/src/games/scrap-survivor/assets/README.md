# Scrap Survivor sprite atlas

Reused from the earlier Scrap Scout prototype.

`scouts.png` is original artwork generated with the built-in image generation tool.
The PNG retains transparent alpha; the renderer divides its actual dimensions into
four equal cells (scout, drone, sentry, barrel). No third-party game assets were used.
Animation, impact flashes, trails, and explosion effects are implemented in Phaser.

Generation prompt:

> Use case: stylized-concept. Asset type: one production sprite atlas for an original mobile 2D ricochet game called Scrap Scout. Create a square transparent PNG sprite sheet with EXACTLY four equally sized cells in a precise 2 by 2 grid, no visible grid lines. Each sprite centered at the exact center of its quadrant, generous transparent padding, entirely inside its own cell. Top left: charming little teal salvage robot with ivory metal body, orange visor, stubby legs, small backpack; top right: hostile rust-red crab drone with four mechanical legs and glowing orange eye; bottom left: chunky purple armored sentry turret with cyan core and short cannon; bottom right: orange cylindrical explosive energy barrel with glowing yellow seams. All viewed from a consistent high three-quarter top-down angle facing down toward camera, crafted hand-painted 2D game art with crisp dark contours, chunky readable silhouettes, polished materials and restrained highlights, playful industrial sci-fi. Exactly one complete object per cell, no scenery, no floor, no ground shadow extending outside sprite, no letters, no numbers, no labels, no border, no watermark. Actual transparent alpha background. Composition must work as four 512 by 512 frames in a 1024 by 1024 atlas.

The generated dimensions are 1254 by 1254, so the game reads frame dimensions from
the decoded image rather than assuming the requested export size.
