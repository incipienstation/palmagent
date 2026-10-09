# Scrap Survivor artwork

Original artwork generated with the built-in image generation tool; no third-party game assets.
Selected PNG outputs were encoded as WebP for delivery (quality 88 for atlases, 85 for the floor,
full-quality alpha). Original canvases are 1254 × 1254; the expansion atlas is 1536 × 1024.
Normalized source rectangles in `../art.tsx`, `../atlas.ts`, and `../combat-art.ts` isolate the sprites.

- `equipment-v2.webp`: six equipment illustrations for upgrade cards and equipped-item slots.
- `expansion.webp`: proximity mine, support drone, elite chest, reactor railgun, magnetic grinder,
  and storm relay. The mine, drone, and chest also appear in the arena; evolutions use beam,
  magnetic ring, and shockwave effects.
- `units.webp`: idle and two walking robot poses, crab drone, sentry, and Warden.
- `combat.webp`: player bolt, circular saw, chain lightning, impact sparks, hostile plasma, and
  tread exhaust. Phaser rotates and pools the sprites, stretches lightning between actual targets,
  and fades impacts with their simulation lifetime. Reactor rings and the magnet pickup field are
  drawn below the combat sprites; exhaust appears only while moving with Turbo treads equipped.
- `floor.webp`: repeating steel floor plates. Phaser adds bay markings, grates, boundary stripes,
  and darker non-walkable surroundings. The arena is 1440 × 1920 world units with a 480 × 640 view.

Movement frames, enemy motion, hit flashes, weapon trails, and HP bars are rendered in Phaser.
Reduced motion disables walking-frame animation, enemy bobbing, camera shake, saw spin, and
exhaust flicker. Attack travel and blade orbits remain visible; pausing freezes combat effects.

## Generation prompts

### Expansion equipment

Use case: stylized-concept. Asset type: one transparent production sprite atlas for Scrap Survivor, a polished hand-painted top-down teal salvage robot game. EXACTLY six separate objects in a square 3-column by 2-row grid. Strong dark outlines, chunky ivory and teal metal, restrained amber/cyan glow, readable silhouettes at 24-64 pixels. Centers x16.67%,50%,83.33% and y25%,75%. Every object contained within its cell with generous transparent gutters, no overlap. Row 1 left: circular teal proximity mine seen straight down, orange armed light and three short silver feet; middle: small friendly teal and ivory flying support drone seen from overhead, two side rotors, orange visor, forward cannon, symmetrical compact silhouette; right: closed chunky industrial salvage chest in high three-quarter perspective, teal metal, broad brass latch and glowing amber seams. Row 2 left: powerful ivory and teal railgun with twin long cyan rails and chunky amber reactor, pointing diagonally upper right; middle: circular magnetic grinder seen straight down, a dark teal hub and four interlocking silver saw cutters with faint cyan magnetic arcs; right: compact violet and teal storm relay coil, bright branching blue-white electric discharge wrapping around the coil. No text, labels, borders, cell lines, background, characters, scenery or watermark. Actual transparent alpha. Consistent visual language and equal visual weight for all six complete silhouettes.

### Expansion transparency and spacing revision

Edit this sprite atlas for production use. Preserve the six object designs and order exactly (mine, drone, chest / railgun, grinder, lightning coil). Remove ALL background haze, broad colored lighting and diffuse glow. Keep opaque mechanical silhouettes and only tiny tight electric sparks attached to the coil. Everything outside the individual object silhouettes MUST have alpha zero, not dark or translucent backdrop. Shrink all six objects to add generous fully transparent gutters. Each complete object must be within its own equal 3-column 2-row cell, with at least 15 percent of cell width and height empty on each side. No ground, no cast shadow, no lettering, no grid lines. Actual transparent alpha background, production sprite sheet.

### Combat effects

Use case: stylized-concept. Asset type: production combat sprite atlas for Scrap Survivor, a top-down teal salvage robot survival game. Create one square transparent sprite sheet with EXACTLY six isolated sprites in an equal 3-column by 2-row grid, centers at x=16.67%,50%,83.33% and y=25%,75%. Each entire sprite including glow must fit within 24% canvas width and 30% canvas height, generous completely transparent gutters. Top row: LEFT a horizontal compact teal-white plasma bolt pointing RIGHT, bright ivory metal nose at right and tapering cyan energy tail to left; CENTER a single circular silver industrial saw blade viewed directly overhead, strong sharp teeth and a teal mechanical hub; RIGHT one horizontal jagged cyan and violet chain lightning segment connecting LEFT to RIGHT, branching sparks confined tightly around its length. Bottom row: LEFT a golden orange star-shaped mechanical impact spark burst with tiny steel chips; CENTER a hostile red-orange hot plasma orb with dark red rim and bright warm core; RIGHT a short amber and cyan tapered engine exhaust flame pointing DOWN, wider at top and narrowing toward bottom. Cohesive polished hand-painted 2D game effects, bold readable silhouettes, crisp dark contours on solid mechanical pieces, broad colors and restrained glow, readable at 16-32 pixels. Effects only, no weapons or characters, no environment, no ground or shadows, no text, labels, grid lines or watermark. Actual transparent alpha background. No overlapping sprites.

### Equipment

Use case: stylized-concept. Asset type: production equipment icon atlas for Scrap Survivor, an original mobile robot survival game. Create ONE square atlas with exactly SIX icons in a precise 3-column by 2-row equal grid. Each icon centered in its cell with 15 percent transparent padding, all objects contained inside their own cell. Row 1 left to right: chunky teal and ivory bolt cannon with orange muzzle; three silver circular saw blades orbiting a teal hub; purple electrical coil with bright cyan lightning. Row 2 left to right: amber glowing reactor core inside a heavy steel cage; red horseshoe scrap magnet holding small metal bolts; pair of teal tracked robot boots with orange exhaust. Cohesive polished hand-painted 2D game inventory art, strong dark outlines, simple bold color blocks, crisp silhouette, chunky bevels, restrained highlights, readable at 64 pixels. High three-quarter view. No floor, no scenic background, no text, no lettering, no frame, no watermark, no cell borders. Actual transparent alpha background. 1536 by 1536 canvas if possible.

### Equipment spacing revision

Edit this equipment atlas for production use. Preserve the exact six illustrated equipment designs and their colors. SHRINK every icon substantially and separate them with LARGE transparent gutters. Canvas square, exactly 3 columns and 2 rows. Icon centers at x=16.67%,50%,83.33% and y=25%,75%. Every complete icon including glow must fit inside a bounding box that is at most 22% of the full canvas width and 28% of the full canvas height. This is mandatory: no silhouette or glow may reach neighboring cells. Add generous empty transparent space all around each icon; use smaller icons rather than filling cells. Order remains cannon, saw blades, lightning coil / reactor, magnet, tread boots. No text, no cell lines, no frames. Actual transparent alpha background.

### Units

Use case: stylized-concept. Asset type: ONE original game character sprite atlas for Scrap Survivor. Square canvas, EXACTLY 3 columns and 2 rows of equal rectangular cells. Every character must occupy AT MOST 65 percent of its cell width and height, centered in its cell, generous transparent gutters separating all six sprites. Row 1 left to right: friendly small teal and ivory salvage robot, bright orange horizontal visor, two stubby tracked feet, front idle pose; same exact robot walking with left foot forward and right foot back; same exact robot walking with right foot forward and left foot back. Row 2 left to right: rust red hostile four-legged crab drone with orange eye; chunky purple sentry turret with short cannon and cyan core; large yellow-orange industrial boss mech with twin heavy arms, black visor, broad shoulders. Consistent high three-quarter top-down perspective for a 2D overhead action game, facing down toward viewer. Polished cartoon game sprites, bold very dark outlines, broad simple color blocks, little surface detail, strong readable silhouettes and clean soft highlights. Transparent alpha, no ground, no shadows outside silhouette, no text, no grid lines, no watermark. Each entire silhouette strictly within its cell with generous empty margin.

### Floor

Use case: stylized-concept. Asset type: seamless square repeating floor texture for an original top-down mobile scrapyard robot game. Orthographic straight-down view, no perspective. A 4 by 4 arrangement of large dark desaturated blue-gray steel floor plates. Fine understated seams join plates, occasional small corner bolts, subtle scratches and restrained patches of oxidized brown metal. Broad quiet color areas and very low contrast so bright teal robots and orange enemies are clearly visible. Hand painted clean cartoon industrial sci-fi game texture matching chunky outlined robots. The texture must seamlessly tile horizontally and vertically, all outer edges share the same quiet steel material. No objects, no robots, no text, no symbols, no thick outlines, no bright highlights, no black void, no vignette, no lighting gradient across the whole image, no borders. Entire canvas opaque floor material.
