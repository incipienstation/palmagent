import Phaser from "phaser";
import combat from "./assets/combat.webp?url";
import { bladeRadius, dronePositions, pickupRadius, type Point, type Run } from "./engine";
import { expansionFrames, expansionTexture, finalWeaponFrames, finalWeaponTexture, finalEffectFrames, finalEffectTexture } from "./atlas";

export const combatTexture = { key: "combat", url: combat };
const frames = {
  bolt: [0.016, 0.225, 0.318, 0.154], blade: [0.355, 0.165, 0.282, 0.277],
  arc: [0.665, 0.226, 0.312, 0.162], hit: [0.042, 0.535, 0.296, 0.294],
  hostile: [0.37, 0.54, 0.267, 0.284], exhaust: [0.738, 0.548, 0.15, 0.29],
} as const;

/** A reusable sprite pool: rendering never changes combat, saved state, or simulation randomness. */
export class CombatArt {
  private sprites: Phaser.GameObjects.Image[] = [];
  private used = 0;
  private field: Phaser.GameObjects.Graphics;
  private bursts: Phaser.GameObjects.Graphics;

  constructor(private scene: Phaser.Scene, private reduced: boolean) {
    const texture = scene.textures.get(combatTexture.key), source = texture.getSourceImage() as HTMLImageElement;
    for (const [name, [x, y, w, h]] of Object.entries(frames)) {
      texture.add(name, 0, Math.round(x * source.width), Math.round(y * source.height), Math.round(w * source.width), Math.round(h * source.height));
    }
    this.field = scene.add.graphics().setDepth(1);
    this.bursts = scene.add.graphics().setDepth(6);
    for (const [atlas, entries] of [[expansionTexture, expansionFrames], [finalWeaponTexture, finalWeaponFrames], [finalEffectTexture, finalEffectFrames]] as const) {
      const extra = scene.textures.get(atlas.key), extraSource = extra.getSourceImage() as HTMLImageElement;
      for (const [name, [x, y, w, h]] of Object.entries(entries)) {
        extra.add(name, 0, Math.round(x * extraSource.width), Math.round(y * extraSource.height), Math.round(w * extraSource.width), Math.round(h * extraSource.height));
      }
    }
  }

  private sprite(frame: keyof typeof frames | keyof typeof expansionFrames | keyof typeof finalWeaponFrames | keyof typeof finalEffectFrames, x: number, y: number, w: number, h: number, angle = 0, alpha = 1, depth = 4, texture = combatTexture.key) {
    const image = this.sprites[this.used] ?? (this.sprites[this.used] = this.scene.add.image(0, 0, combatTexture.key));
    this.used++;
    return image.setTexture(texture, frame).setPosition(x, y).setDisplaySize(w, h).setRotation(angle).setAlpha(alpha).setDepth(depth).setVisible(true).clearTint();
  }

  draw(r: Run, movement: Point, moving: boolean) {
    this.used = 0;
    const g = this.field.clear(), bursts = this.bursts.clear(), p = r.player;
    for (const chest of r.chests) {
      g.lineStyle(2, 0xffce74, 0.6).strokeCircle(chest.x, chest.y, 23);
      this.sprite("chest", chest.x, chest.y, 34, 30, 0, 1, 3, expansionTexture.key);
    }
    for (const mine of r.mines) {
      const evolved = r.evolutions.mine, size = evolved ? 31 : 22;
      this.sprite("mine", mine.x, mine.y, size, size, 0, mine.arm > 0 ? 0.5 : 1, 2, evolved ? finalWeaponTexture.key : expansionTexture.key);
      if (mine.fuse !== undefined) {
        const size = 120 + (1 - mine.fuse / 0.65) * 80;
        this.sprite("gravity", mine.x, mine.y, size, size, this.reduced ? 0 : r.time * 3, 0.6, 1, finalEffectTexture.key);
      } else if (mine.arm <= 0) g.lineStyle(1, evolved ? 0xbd8cff : 0xffc36c, 0.25).strokeCircle(mine.x, mine.y, evolved ? 45 : 32);
    }
    const aim = (from: Point) => {
      const target = r.enemies.reduce<Run["enemies"][number] | undefined>((best, e) => !best || Math.hypot(e.x - from.x, e.y - from.y) < Math.hypot(best.x - from.x, best.y - from.y) ? e : best, undefined);
      return target ? Math.atan2(target.y - from.y, target.x - from.x) : 0;
    };
    for (const drone of dronePositions(r)) this.sprite("drone", drone.x, drone.y, r.evolutions.drone ? 39 : 31, r.evolutions.drone ? 39 : 25,
      r.evolutions.drone ? aim(drone) : 0, 1, 5, r.evolutions.drone ? finalWeaponTexture.key : expansionTexture.key);
    if (r.evolutions.bolt) {
      const angle = aim(p);
      this.sprite("bolt", p.x + Math.cos(angle) * 18, p.y + Math.sin(angle) * 18, 38, 29, angle, 1, 5, finalWeaponTexture.key);
    }
    if (r.evolutions.arc) this.sprite("arc", p.x - 21, p.y - 17, 28, 37, 0, 1, 5, finalWeaponTexture.key);
    if (r.upgrades.reactor) {
      const radius = 24 + r.upgrades.reactor * 2;
      g.lineStyle(4, 0xffbf61, 0.12).strokeCircle(p.x, p.y, radius);
      g.lineStyle(1.5, 0xffd581, 0.4).strokeCircle(p.x, p.y, radius - 3);
    }
    if (r.upgrades.magnet) {
      const radius = pickupRadius(r);
      // The field follows the actual pickup radius; quiet dashes keep enemy telegraphs readable.
      for (let i = 0; i < 12; i++) {
        const angle = i * Math.PI / 6;
        g.lineStyle(1.5, 0x79e4c4, 0.2).beginPath().arc(p.x, p.y, radius, angle, angle + 0.13).strokePath();
      }
      for (const gem of r.gems) {
        const dx = p.x - gem.x, dy = p.y - gem.y, distance = Math.hypot(dx, dy);
        if (distance > 18 && distance < radius) g.lineStyle(2, 0x79e4c4, 0.35).lineBetween(gem.x, gem.y, gem.x - dx / distance * 9, gem.y - dy / distance * 9);
      }
    }
    if (moving && r.upgrades.boots) {
      const angle = Math.atan2(movement.y, movement.x), dx = Math.cos(angle), dy = Math.sin(angle);
      const length = 23 + r.upgrades.boots * 3 + (this.reduced ? 0 : Math.sin(r.time * 24) * 2);
      for (const side of [-1, 1]) this.sprite("exhaust", p.x - dx * 19 - dy * side * 10, p.y - dy * 19 + dx * side * 10,
        11, length, angle + Math.PI / 2, 0.85, 1);
    }
    for (const b of r.bullets) {
      const angle = Math.atan2(b.vy, b.vx);
      if (b.hostile) this.sprite("hostile", b.x, b.y, 14, 14, 0, 1);
      else if (b.kind === "missile") this.sprite("missile", b.x, b.y, 31, 13, angle, 1, 4, finalWeaponTexture.key);
      else {
        const length = b.pierce > 0 ? 30 : 23;
        // The solid nose sits on the simulated projectile; its trail extends behind it.
        this.sprite("bolt", b.x - Math.cos(angle) * length * 0.3, b.y - Math.sin(angle) * length * 0.3,
          length, b.pierce > 0 ? 12 : 10, angle).setTint(b.kind === "drone" ? 0xffd68b : 0xffffff);
      }
    }
    const lv = r.upgrades.blade;
    if (lv) {
      const radius = bladeRadius(r);
      g.lineStyle(1, 0x82d4ff, 0.18).strokeCircle(p.x, p.y, radius);
      for (let i = 0; i <= lv; i++) {
        const angle = r.time * 4 + i * Math.PI * 2 / (lv + 1);
        this.sprite("blade", p.x + Math.cos(angle) * radius, p.y + Math.sin(angle) * radius,
          r.evolutions.blade ? 30 : 24, r.evolutions.blade ? 30 : 24, this.reduced ? 0 : -r.time * 12 + i,
          1, 4, r.evolutions.blade ? finalWeaponTexture.key : combatTexture.key);
      }
    }
    for (const fx of r.effects) {
      if (fx.kind === "rail" && fx.from) {
        const dx = fx.x - fx.from.x, dy = fx.y - fx.from.y;
        this.sprite("rail", (fx.x + fx.from.x) / 2, (fx.y + fx.from.y) / 2, Math.hypot(dx, dy), 24,
          Math.atan2(dy, dx), Math.min(1, fx.ttl * 6), 6, finalEffectTexture.key);
      } else if (fx.kind === "storm" || fx.kind === "implosion" || fx.kind === "missile") {
        const progress = 1 - fx.ttl / 0.4, radius = fx.radius ?? 60;
        const size = radius * 2 * (fx.kind === "implosion" ? 1 - progress * 0.5 : 0.5 + progress * 0.5);
        this.sprite(fx.kind, fx.x, fx.y, size, size, 0, Math.min(1, fx.ttl * 4), 6, finalEffectTexture.key);
      } else if (fx.kind === "blast") {
        const radius = (fx.radius ?? 60) * (1 - fx.ttl / 0.5), color = 0xffb85c;
        bursts.lineStyle(3, color, fx.ttl * 1.8).strokeCircle(fx.x, fx.y, radius);
        bursts.fillStyle(color, fx.ttl * 0.16).fillCircle(fx.x, fx.y, radius);
        this.sprite("hit", fx.x, fx.y, 30, 30, 0, Math.min(1, fx.ttl * 3), 6).setTint(color);
      } else if (fx.kind === "arc" && fx.from) {
        const dx = fx.x - fx.from.x, dy = fx.y - fx.from.y, distance = Math.hypot(dx, dy);
        const angle = Math.atan2(dy, dx), count = Math.max(1, Math.ceil(distance / 64));
        for (let i = 0; i < count; i++) {
          const t = (i + 0.5) / count;
          this.sprite("arc", fx.from.x + dx * t, fx.from.y + dy * t, distance / count + 3,
            r.evolutions.arc ? 24 : 16, angle, Math.min(1, fx.ttl / 0.12), 6, r.evolutions.arc ? finalEffectTexture.key : combatTexture.key);
        }
      } else if (fx.kind === "hit" || fx.kind === "kill") {
        const progress = 1 - fx.ttl / 0.4, size = fx.kind === "kill" ? 27 : 16;
        this.sprite("hit", fx.x, fx.y, size * (1 + progress * 0.5), size * (1 + progress * 0.5),
          (fx.x + fx.y) % (Math.PI * 2), Math.min(1, fx.ttl / 0.22), 6);
      }
    }
    for (let i = this.used; i < this.sprites.length; i++) this.sprites[i].setVisible(false);
  }
}
