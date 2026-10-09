import Phaser from "phaser";
import combat from "./assets/combat.webp?url";
import type { Point, Run } from "./engine";

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

  constructor(private scene: Phaser.Scene, private reduced: boolean) {
    const texture = scene.textures.get(combatTexture.key), source = texture.getSourceImage() as HTMLImageElement;
    for (const [name, [x, y, w, h]] of Object.entries(frames)) {
      texture.add(name, 0, Math.round(x * source.width), Math.round(y * source.height), Math.round(w * source.width), Math.round(h * source.height));
    }
    this.field = scene.add.graphics().setDepth(1);
  }

  private sprite(frame: keyof typeof frames, x: number, y: number, w: number, h: number, angle = 0, alpha = 1, depth = 4) {
    const image = this.sprites[this.used] ?? (this.sprites[this.used] = this.scene.add.image(0, 0, combatTexture.key));
    this.used++;
    return image.setFrame(frame).setPosition(x, y).setDisplaySize(w, h).setRotation(angle).setAlpha(alpha).setDepth(depth).setVisible(true).clearTint();
  }

  draw(r: Run, movement: Point, moving: boolean) {
    this.used = 0;
    const g = this.field.clear(), p = r.player;
    if (r.upgrades.reactor) {
      const radius = 24 + r.upgrades.reactor * 2;
      g.lineStyle(4, 0xffbf61, 0.12).strokeCircle(p.x, p.y, radius);
      g.lineStyle(1.5, 0xffd581, 0.4).strokeCircle(p.x, p.y, radius - 3);
    }
    if (r.upgrades.magnet) {
      const radius = 55 + r.upgrades.magnet * 35;
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
      else {
        const length = b.pierce > 0 ? 30 : 23;
        // The solid nose sits on the simulated projectile; its trail extends behind it.
        this.sprite("bolt", b.x - Math.cos(angle) * length * 0.3, b.y - Math.sin(angle) * length * 0.3,
          length, b.pierce > 0 ? 12 : 10, angle);
      }
    }
    const lv = r.upgrades.blade;
    if (lv) {
      const radius = 42 + lv * 9;
      g.lineStyle(1, 0x82d4ff, 0.18).strokeCircle(p.x, p.y, radius);
      for (let i = 0; i <= lv; i++) {
        const angle = r.time * 4 + i * Math.PI * 2 / (lv + 1);
        this.sprite("blade", p.x + Math.cos(angle) * radius, p.y + Math.sin(angle) * radius,
          24, 24, this.reduced ? 0 : -r.time * 12 + i);
      }
    }
    for (const fx of r.effects) {
      if (fx.kind === "arc" && fx.from) {
        const dx = fx.x - fx.from.x, dy = fx.y - fx.from.y, distance = Math.hypot(dx, dy);
        const angle = Math.atan2(dy, dx), count = Math.max(1, Math.ceil(distance / 64));
        for (let i = 0; i < count; i++) {
          const t = (i + 0.5) / count;
          this.sprite("arc", fx.from.x + dx * t, fx.from.y + dy * t, distance / count + 3,
            16, angle, Math.min(1, fx.ttl / 0.12), 6);
        }
      } else if (fx.kind !== "arc") {
        const progress = 1 - fx.ttl / 0.4, size = fx.kind === "kill" ? 27 : 16;
        this.sprite("hit", fx.x, fx.y, size * (1 + progress * 0.5), size * (1 + progress * 0.5),
          (fx.x + fx.y) % (Math.PI * 2), Math.min(1, fx.ttl / 0.22), 6);
      }
    }
    for (let i = this.used; i < this.sprites.length; i++) this.sprites[i].setVisible(false);
  }
}
