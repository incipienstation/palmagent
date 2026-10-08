import Phaser from "phaser";
import sprites from "./assets/scouts.png?url";
import { H, W, STEP, step, type Point, type Run } from "./engine";

export function preloadSprites(): Promise<void> {
  return new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(); img.onerror = reject; img.src = sprites; });
}
export function createArena(parent: HTMLElement, getRun: () => Run, movement: () => Point, paused: () => boolean,
  onMove: (point: Point) => void, onUpdate: () => void, onReady: (ready: boolean) => void): () => void {
  let cancelled = false;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  class Survival extends Phaser.Scene {
    private robot!: Phaser.GameObjects.Image;
    private paint!: Phaser.GameObjects.Graphics;
    private art = new Map<number, Phaser.GameObjects.Image>();
    private elapsed = 0;
    private report = 0;
    private hull = 8;
    private anchor?: Point;
    private seen = new WeakSet<object>();
    preload() { this.load.image("survivor", sprites); }
    create() {
      if (cancelled) return;
      if (!this.textures.exists("survivor")) { onReady(false); return; }
      const texture = this.textures.get("survivor"), source = texture.getSourceImage() as HTMLImageElement, cell = source.width / 2;
      for (let i = 0; i < 4; i++) texture.add(String(i), 0, i % 2 * cell, Math.floor(i / 2) * cell, cell, cell);
      const floor = this.add.graphics().fillStyle(0x101f2a).fillRoundedRect(0, 0, W, H, 18);
      floor.lineStyle(1, 0x243c47, 0.7);
      for (let x = 0; x < W; x += 40) floor.lineBetween(x, 0, x, H);
      for (let y = 0; y < H; y += 40) floor.lineBetween(0, y, W, y);
      floor.lineStyle(6, 0x48616b).strokeRoundedRect(9, 9, W - 18, H - 18, 14);
      for (let y = 36; y < H - 20; y += 70) floor.fillStyle(0xf7b953, 0.8).fillRect(6, y, 6, 22).fillRect(W - 12, y, 6, 22);
      this.paint = this.add.graphics().setDepth(3);
      this.robot = this.add.image(W / 2, H / 2, "survivor", "0").setDisplaySize(46, 46).setDepth(5);
      this.input.on("pointerdown", (p: Phaser.Input.Pointer) => { this.anchor = { x: p.x, y: p.y }; });
      this.input.on("pointermove", (p: Phaser.Input.Pointer) => {
        if (p.isDown && this.anchor) { const x = p.x - this.anchor.x, y = p.y - this.anchor.y, n = Math.max(32, Math.hypot(x, y)); onMove({ x: x / n, y: y / n }); }
      });
      const release = () => { this.anchor = undefined; onMove({ x: 0, y: 0 }); };
      this.input.on("pointerup", release); this.input.on("pointerupoutside", release); this.input.on("gameout", release);
      onReady(true); this.draw();
    }
    private draw() {
      if (!this.paint) return;
      const r = getRun(), g = this.paint.clear(), ids = new Set(r.enemies.map(e => e.id));
      for (const [id, sprite] of this.art) if (!ids.has(id)) { sprite.destroy(); this.art.delete(id); }
      for (const e of r.enemies) {
        let sprite = this.art.get(e.id);
        if (!sprite) { sprite = this.add.image(e.x, e.y, "survivor", "1").setDepth(2); this.art.set(e.id, sprite); }
        const boss = e.kind === "boss", frame = e.kind === "sentry" || boss ? "2" : "1";
        sprite.setTexture("survivor", frame).setPosition(e.x, e.y).setDisplaySize(boss ? 86 : 40, boss ? 86 : 40);
        if (e.kind === "charger") sprite.setTint(0xffb56c); else sprite.clearTint();
        if (e.hp < e.max || boss) { g.fillStyle(0x29313d).fillRect(e.x - 18, e.y - (boss ? 42 : 24), 36, 4); g.fillStyle(0xff836f).fillRect(e.x - 18, e.y - (boss ? 42 : 24), 36 * e.hp / e.max, 4); }
        if ((e.kind === "charger" && e.clock < 0.65 && e.dash <= 0) || (boss && e.clock < 0.5)) {
          g.lineStyle(2, 0xff7866, 0.7).strokeCircle(e.x, e.y, boss ? 44 : 25);
          g.lineBetween(e.x, e.y, r.player.x, r.player.y);
        }
      }
      for (const gem of r.gems) { g.fillStyle(0x61f2b8).fillTriangle(gem.x, gem.y - 5, gem.x - 4, gem.y, gem.x, gem.y + 5); g.fillTriangle(gem.x, gem.y - 5, gem.x + 4, gem.y, gem.x, gem.y + 5); }
      for (const b of r.bullets) {
        g.fillStyle(b.hostile ? 0xff755f : 0xc4fff0).fillCircle(b.x, b.y, b.hostile ? 5 : 3);
        if (!b.hostile) g.lineStyle(2, 0x68e6e7, 0.6).lineBetween(b.x, b.y, b.x - b.vx * 0.025, b.y - b.vy * 0.025);
      }
      const lv = r.upgrades.blade;
      if (lv) {
        const radius = 42 + lv * 9;
        g.lineStyle(1, 0x82d4ff, 0.18).strokeCircle(r.player.x, r.player.y, radius);
        for (let i = 0; i <= lv; i++) { const a = r.time * 4 + i * Math.PI * 2 / (lv + 1), x = r.player.x + Math.cos(a) * radius, y = r.player.y + Math.sin(a) * radius;
          g.lineStyle(5, 0xaedbff).lineBetween(x - Math.cos(a + 1) * 10, y - Math.sin(a + 1) * 10, x + Math.cos(a + 1) * 10, y + Math.sin(a + 1) * 10); }
      }
      for (const fx of r.effects) {
        if (fx.kind === "arc" && fx.from) g.lineStyle(3, 0xace6ff, fx.ttl / 0.2).lineBetween(fx.from.x, fx.from.y, fx.x, fx.y);
        else {
          g.lineStyle(2, fx.kind === "kill" ? 0xffc664 : 0xffffff, fx.ttl / 0.4).strokeCircle(fx.x, fx.y, (0.4 - fx.ttl) * (fx.kind === "kill" ? 75 : 30) + 4);
          if (!this.seen.has(fx)) {
            this.seen.add(fx);
            const text = this.add.text(fx.x, fx.y - 15, String(fx.value), { fontSize: "13px", fontFamily: "system-ui", color: "#fff0c8", stroke: "#18232d", strokeThickness: 3 }).setOrigin(0.5).setDepth(6);
            this.tweens.add({ targets: text, y: fx.y - 35, alpha: 0, duration: 350, onComplete: () => text.destroy() });
          }
        }
      }
      this.robot.setPosition(r.player.x, r.player.y).setAlpha(r.invulnerable > 0 && Math.floor(r.time * 12) % 2 ? 0.5 : 1);
      if (r.hull < this.hull && !reduced) this.cameras.main.shake(100, 0.004);
      this.hull = r.hull;
      if (this.anchor && !paused()) { g.lineStyle(2, 0xffffff, 0.35).strokeCircle(this.anchor.x, this.anchor.y, 32); }
    }
    update(_time: number, delta: number) {
      if (!this.paint) return;
      if (paused()) { this.elapsed = 0; this.anchor = undefined; this.draw(); return; }
      this.elapsed += Math.min(delta, 100) / 1000;
      while (this.elapsed >= STEP) { step(getRun(), movement()); this.elapsed -= STEP; }
      this.draw(); this.report += delta;
      if (this.report >= 100) { this.report = 0; onUpdate(); }
    }
  }
  const game = new Phaser.Game({ type: Phaser.AUTO, parent, width: W, height: H, transparent: true, scene: Survival,
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH }, audio: { noAudio: true }, banner: false,
    input: { keyboard: false, mouse: { preventDefaultWheel: false }, touch: { capture: true } }, fps: { target: 60 } });
  const resize = new ResizeObserver(() => { if (game.isBooted) { game.scale.getParentBounds(); game.scale.refresh(); } });
  resize.observe(parent);
  return () => { cancelled = true; resize.disconnect(); game.destroy(true); };
}
