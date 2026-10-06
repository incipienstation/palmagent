import Phaser from "phaser";
import atlasUrl from "./assets/scouts.png?url";
import { W, H, ORIGIN, clampAim, cleared, type Run, type Frame, type Impact } from "./engine";

export type Arena = { sync: (run: Run, aim: number) => void; play: (frames: Frame[], done: () => void) => void; destroy: () => void };
export function createArena(parent: HTMLElement, initial: Run, onAim: (angle: number) => void, ready: (arena: Arena | null) => void): () => void {
  let run = initial, aim = 0, cancelled = false;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  class ArenaScene extends Phaser.Scene {
    private art = new Map<number, Phaser.GameObjects.Image>();
    private labels = new Map<number, Phaser.GameObjects.Text>();
    private guide!: Phaser.GameObjects.Graphics;
    private balls: Phaser.GameObjects.Arc[] = [];
    private trace?: { frames: Frame[]; cursor: number; elapsed: number; done: () => void };
    preload() { this.load.image("scouts", atlasUrl); }
    create() {
      if (cancelled) return;
      if (!this.textures.exists("scouts")) { ready(null); return; }
      const texture = this.textures.get("scouts"), source = texture.getSourceImage() as HTMLImageElement;
      const cell = source.width / 2;
      for (let i = 0; i < 4; i++) texture.add(String(i), 0, (i % 2) * cell, Math.floor(i / 2) * cell, cell, cell);
      const floor = this.add.graphics();
      floor.fillStyle(0x111d29).fillRoundedRect(0, 0, W, H, 20);
      floor.lineStyle(1, 0x263746, 0.7);
      for (let x = 20; x < W; x += 40) floor.lineBetween(x, 0, x, H);
      for (let y = 0; y < H; y += 40) floor.lineBetween(0, y, W, y);
      floor.lineStyle(5, 0x4a6170).strokeRoundedRect(8, 8, W - 16, H - 16, 16);
      for (const x of [16, W - 16]) for (const y of [55, 125, 195, 265, 335]) {
        floor.fillStyle(0xf4b25e, 0.8).fillRoundedRect(x - 3, y, 6, 24, 2);
      }
      floor.fillStyle(0x153e42).fillEllipse(ORIGIN.x, ORIGIN.y + 10, 85, 32);
      this.add.image(ORIGIN.x, ORIGIN.y - 4, "scouts", "0").setDisplaySize(65, 65).setDepth(5);
      this.guide = this.add.graphics().setDepth(2);
      this.input.on("pointerdown", (p: Phaser.Input.Pointer) => this.point(p));
      this.input.on("pointermove", (p: Phaser.Input.Pointer) => { if (p.isDown) this.point(p); });
      this.draw();
      ready({ sync: (next, angle) => { run = next; aim = angle; if (!this.trace) this.draw(); },
        play: (frames, done) => { this.trace = { frames, cursor: 0, elapsed: 0, done }; this.guide.clear(); },
        destroy: () => game.destroy(true) });
    }
    private point(p: Phaser.Input.Pointer) {
      if (this.trace || run.hull <= 0 || cleared(run)) return;
      aim = Math.round(clampAim(Math.atan2(p.x - ORIGIN.x, ORIGIN.y - Math.min(p.y, ORIGIN.y - 20)) * 180 / Math.PI));
      this.drawGuide(); onAim(aim);
    }
    private drawGuide() {
      this.guide.clear();
      if (cleared(run) || run.hull <= 0) return;
      const rad = aim * Math.PI / 180;
      let x = ORIGIN.x, y = ORIGIN.y, vx = Math.sin(rad) * 12, vy = -Math.cos(rad) * 12;
      this.guide.fillStyle(0x82f4d5, 0.65);
      for (let i = 0; i < 23; i++) {
        x += vx; y += vy;
        if (x < 15 || x > W - 15) { vx *= -1; x = Math.max(15, Math.min(W - 15, x)); }
        if (y < 20) { vy *= -1; y = 20; }
        if (i > 1) this.guide.fillCircle(x, y, i % 2 ? 1.5 : 2.5);
      }
    }
    private draw() {
      this.art.forEach(s => s.destroy()); this.labels.forEach(s => s.destroy()); this.art.clear(); this.labels.clear();
      for (const t of run.targets) {
        if (t.hp <= 0) continue;
        const frame = t.kind === "barrel" ? "3" : t.kind === "drone" ? "1" : "2";
        const size = t.kind === "boss" ? 105 : t.kind === "barrel" ? 51 : 65;
        const sprite = this.add.image(t.x, t.y, "scouts", frame).setDisplaySize(size, size).setDepth(3);
        if (t.kind === "boss") sprite.setTint(0xffbdc6);
        this.art.set(t.id, sprite);
        this.labels.set(t.id, this.add.text(t.x, t.y + t.radius + 5, t.kind === "barrel" ? "BLAST" : String(t.hp),
          { fontFamily: "system-ui", fontSize: t.kind === "barrel" ? "9px" : "12px", color: t.kind === "barrel" ? "#ffd281" : "#ffffff", backgroundColor: "#172633", padding: { x: 5, y: 2 } }).setOrigin(0.5, 0).setDepth(4));
      }
      this.drawGuide();
    }
    private impact(event: Impact) {
      const sprite = this.art.get(event.target), label = this.labels.get(event.target);
      if (event.kind === "blast") {
        const ring = this.add.circle(event.x, event.y, 12, 0xffc164, 0.4).setStrokeStyle(3, 0xffd789).setDepth(6);
        this.tweens.add({ targets: ring, scale: 8, alpha: 0, duration: reduced ? 120 : 420, onComplete: () => ring.destroy() });
        if (!reduced) this.cameras.main.shake(110, 0.006);
      } else {
        if (event.from) {
          const bolt = this.add.graphics().lineStyle(3, 0x98e9ff).setDepth(7);
          bolt.lineBetween(event.from.x, event.from.y, event.x, event.y);
          this.tweens.add({ targets: bolt, alpha: 0, duration: 220, onComplete: () => bolt.destroy() });
        }
        const text = this.add.text(event.x, event.y - 18, `−${event.damage}`, { fontFamily: "system-ui", fontSize: "19px", fontStyle: "bold", color: "#ffe6a2", stroke: "#16232c", strokeThickness: 3 }).setOrigin(0.5).setDepth(8);
        this.tweens.add({ targets: text, y: event.y - 50, alpha: 0, duration: 550, onComplete: () => text.destroy() });
        for (let i = 0; i < 6; i++) {
          const a = i * Math.PI / 3, spark = this.add.circle(event.x, event.y, 2, 0xffd075).setDepth(6);
          this.tweens.add({ targets: spark, x: event.x + Math.cos(a) * 32, y: event.y + Math.sin(a) * 32, alpha: 0, duration: 260, onComplete: () => spark.destroy() });
        }
      }
      if (sprite) {
        if (event.hp <= 0) { this.tweens.add({ targets: sprite, alpha: 0, angle: 25, duration: 180 }); label?.setVisible(false); }
        else { label?.setText(String(event.hp)); sprite.setTintFill(0xffffff); this.time.delayedCall(65, () => { if (sprite.active) sprite.clearTint(); }); }
      }
    }
    update(_time: number, delta: number) {
      const trace = this.trace;
      if (!trace) return;
      trace.elapsed += Math.min(delta, 50);
      while (trace.elapsed >= 16 && trace.cursor < trace.frames.length) {
        trace.elapsed -= 16;
        const frame = trace.frames[trace.cursor++];
        frame.balls.forEach((p, i) => {
          const orb = this.balls[i] ??= this.add.circle(p.x, p.y, 6, 0xbcfff0).setStrokeStyle(3, 0x3ddcaf, 0.7).setDepth(7);
          orb.setPosition(p.x, p.y);
        });
        frame.impacts.forEach(e => this.impact(e));
      }
      if (trace.cursor >= trace.frames.length) {
        this.trace = undefined; this.balls.forEach(b => b.destroy()); this.balls = [];
        this.time.delayedCall(220, () => { trace.done(); this.draw(); });
      }
    }
  }
  const game = new Phaser.Game({ type: Phaser.CANVAS, parent, width: W, height: H, transparent: true, scene: ArenaScene,
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH }, audio: { noAudio: true },
    input: { keyboard: false, mouse: { preventDefaultWheel: false }, touch: { capture: true } }, banner: false,
    fps: { target: 60, forceSetTimeOut: false } });
  const resize = new ResizeObserver(() => {
    if (game.isBooted) { game.scale.getParentBounds(); game.scale.refresh(); }
  });
  resize.observe(parent);
  return () => { cancelled = true; resize.disconnect(); game.destroy(true); };
}
