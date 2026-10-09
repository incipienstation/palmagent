import Phaser from "phaser";
import sprites from "./assets/units.webp?url";
import floorTiles from "./assets/floor.webp?url";
import { unitFrames, expansionTexture, robotFrames, robotTexture, finalWeaponTexture, finalEffectTexture } from "./atlas";
import { CombatArt, combatTexture } from "./combat-art";
import { H, W, WORLD_W, WORLD_H, PLAYER_SCREEN_Y, STEP, RELAY_SECONDS, maxHull, step, type Point, type Run } from "./engine";

export function preloadSprites(): Promise<void> {
  return new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(); img.onerror = reject; img.src = sprites; });
}
export function createArena(parent: HTMLElement, getRun: () => Run, movement: () => Point, paused: () => boolean,
  onUpdate: () => void, onReady: (ready: boolean) => void): () => void {
  let cancelled = false;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  class Survival extends Phaser.Scene {
    private robot!: Phaser.GameObjects.Image;
    private health!: Phaser.GameObjects.Graphics;
    private shadow!: Phaser.GameObjects.Ellipse;
    private paint!: Phaser.GameObjects.Graphics;
    private floor!: Phaser.GameObjects.TileSprite;
    private relayLabels: Phaser.GameObjects.Text[] = [];
    private art = new Map<number, Phaser.GameObjects.Image>();
    private combat!: CombatArt;
    private elapsed = 0;
    private report = 0;
    private hull = 8;
    private seen = new WeakSet<object>();
    preload() { this.load.image("survivor", sprites); this.load.image("floor", floorTiles); this.load.image(combatTexture.key, combatTexture.url); this.load.image(expansionTexture.key, expansionTexture.url); this.load.image(robotTexture.key, robotTexture.url); this.load.image(finalWeaponTexture.key, finalWeaponTexture.url); this.load.image(finalEffectTexture.key, finalEffectTexture.url); }
    create() {
      if (cancelled) return;
      if (!["survivor", "floor", combatTexture.key, expansionTexture.key, robotTexture.key, finalWeaponTexture.key, finalEffectTexture.key].every(key => this.textures.exists(key))) { onReady(false); return; }
      const texture = this.textures.get("survivor"), source = texture.getSourceImage() as HTMLImageElement;
      unitFrames.forEach(([x, y, w, h], i) => texture.add(String(i), 0, Math.round(x * source.width), Math.round(y * source.height), Math.round(w * source.width), Math.round(h * source.height)));
      const robotAtlas = this.textures.get(robotTexture.key), robotSource = robotAtlas.getSourceImage() as HTMLImageElement;
      robotFrames.forEach(([x, y, w, h], i) => robotAtlas.add(String(i), 0, Math.round(x * robotSource.width), Math.round(y * robotSource.height), Math.round(w * robotSource.width), Math.round(h * robotSource.height)));
      // Overscan outside the walking boundary keeps the robot clear of controls at every edge.
      const floor = this.add.tileSprite(WORLD_W / 2, WORLD_H / 2, WORLD_W + W * 2, WORLD_H + H * 2, "floor");
      this.floor = floor;
      const tileSource = this.textures.get("floor").getSourceImage() as HTMLImageElement;
      floor.setTileScale(256 / tileSource.width, 256 / tileSource.height).setTint(0x8da5ab);
      const markings = this.add.graphics();
      markings.fillStyle(0x06131a, 0.65)
        .fillRect(-W, -H, W, WORLD_H + H * 2).fillRect(WORLD_W, -H, W, WORLD_H + H * 2)
        .fillRect(0, -H, WORLD_W, H).fillRect(0, WORLD_H, WORLD_W, H);
      markings.lineStyle(12, 0x0c1820).strokeRect(8, 8, WORLD_W - 16, WORLD_H - 16);
      markings.lineStyle(3, 0xc4a164, 0.65).strokeRect(16, 16, WORLD_W - 32, WORLD_H - 32);
      for (let x = 32; x < WORLD_W; x += 64) {
        markings.fillStyle(0xc4a164, 0.5).fillRect(x, 4, 22, 8).fillRect(x, WORLD_H - 12, 22, 8);
      }
      for (let y = 32; y < WORLD_H; y += 64) markings.fillStyle(0xc4a164, 0.5).fillRect(4, y, 8, 22).fillRect(WORLD_W - 12, y, 8, 22);
      // Low-contrast floor bays and grates are landmarks, never hidden collision obstacles.
      for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) {
        const x = col * W + 75, y = row * H + 100;
        markings.lineStyle(2, 0x799b9c, 0.25).strokeRoundedRect(x, y, 330, 380, 8);
        markings.fillStyle(0x12222b, 0.4).fillRect(x + 110, y + 155, 110, 70);
        for (let n = 0; n < 7; n++) markings.lineStyle(3, 0x6f8587, 0.18).lineBetween(x + 120, y + 163 + n * 8, x + 210, y + 163 + n * 8);
        this.add.text(x + 12, y + 12, `BAY 0${row * 3 + col + 1}`, { fontSize: "18px", fontFamily: "monospace", color: "#738d91" }).setAlpha(0.35);
      }
      this.paint = this.add.graphics().setDepth(3);
      this.relayLabels = Array.from({ length: 3 }, () => this.add.text(0, 0, "", { fontSize: "12px", fontFamily: "system-ui", color: "#d0fff0", stroke: "#10232c", strokeThickness: 4 }).setOrigin(0.5).setDepth(4));
      this.shadow = this.add.ellipse(0, 0, 34, 14, 0x031019, 0.45).setDepth(1);
      this.robot = this.add.image(0, 0, "survivor", "0").setDisplaySize(38, 46).setDepth(5);
      this.health = this.add.graphics().setDepth(7);
      this.combat = new CombatArt(this, reduced);
      onReady(true); this.draw();
    }
    private draw() {
      if (!this.paint) return;
      const r = getRun(), g = this.paint.clear(), ids = new Set(r.enemies.map(e => e.id));
      this.floor.setTint(r.rig.sector === 1 ? 0x8da5ab : r.rig.sector === 2 ? 0xba977a : 0x9386bc);
      this.relayLabels.forEach((label, i) => {
        const relay = r.relays[i]; label.setVisible(Boolean(relay));
        if (!relay) return;
        const restored = relay.charge >= RELAY_SECONDS, color = restored ? 0x78e4b7 : 0x74d9ff;
        g.fillStyle(0x102b35, 0.65).fillCircle(relay.x, relay.y, 58);
        g.lineStyle(2, color, 0.65).strokeCircle(relay.x, relay.y, 58);
        g.lineStyle(5, color).beginPath().arc(relay.x, relay.y, 58, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * relay.charge / RELAY_SECONDS).strokePath();
        g.fillStyle(0x253946).fillRoundedRect(relay.x - 13, relay.y - 20, 26, 36, 5);
        g.lineStyle(2, color).strokeRoundedRect(relay.x - 13, relay.y - 20, 26, 36, 5);
        g.fillStyle(color).fillRect(relay.x - 7, relay.y - 13, 14, restored ? 22 : 7);
        label.setPosition(relay.x, relay.y + 77).setText(restored ? `RELAY ${i + 1} RESTORED` : `RELAY ${i + 1} · STAY NEAR TO RESTORE`);
      });
      for (const hazard of r.hazards) {
        const active = hazard.ttl <= 0.9, color = r.rig.sector === 3 ? 0xc6a5ff : 0xff9b59;
        g.fillStyle(color, active ? 0.45 : 0.1).fillCircle(hazard.x, hazard.y, 55);
        g.lineStyle(active ? 4 : 2, color).strokeCircle(hazard.x, hazard.y, 55);
        g.lineBetween(hazard.x - 10, hazard.y - 10, hazard.x + 10, hazard.y + 10);
        g.lineBetween(hazard.x + 10, hazard.y - 10, hazard.x - 10, hazard.y + 10);
        if (!active) g.lineStyle(2, color, 0.7).strokeCircle(hazard.x, hazard.y, 55 * (2.4 - hazard.ttl) / 1.5);
      }
      for (const [id, sprite] of this.art) if (!ids.has(id)) { sprite.destroy(); this.art.delete(id); }
      for (const e of r.enemies) {
        let sprite = this.art.get(e.id);
        if (!sprite) { sprite = this.add.image(e.x, e.y, "survivor", "1").setDepth(2); this.art.set(e.id, sprite); }
        const boss = e.kind === "boss", elite = e.kind === "elite", frame = boss ? "5" : e.kind === "sentry" || elite ? "4" : "3";
        const bob = reduced ? 0 : Math.sin(r.time * (e.kind === "charger" ? 16 : 8) + e.id) * 1.3;
        sprite.setTexture("survivor", frame).setPosition(e.x, e.y + bob).setDisplaySize(boss ? 82 : elite ? 60 : 40, boss ? 78 : elite ? 66 : e.kind === "sentry" ? 48 : 33);
        sprite.setRotation(reduced ? 0 : e.kind === "charger" && e.dash > 0 ? Math.sin(r.time * 30) * 0.12 : Math.sin(r.time * 5 + e.id) * 0.035);
        if (r.effects.some(fx => fx.kind === "hit" && fx.ttl > 0.3 && Math.hypot(fx.x - e.x, fx.y - e.y) < 25)) sprite.setTintFill(0xffffff);
        else if (elite) sprite.setTint(0xffcf6a); else if (e.kind === "charger") sprite.setTint(0xffb56c); else sprite.clearTint();
        if (elite) g.lineStyle(2, 0xffcf6a, 0.7).strokeCircle(e.x, e.y, 34);
        if (e.hp < e.max || boss || elite) { g.fillStyle(0x29313d).fillRect(e.x - 18, e.y - (boss ? 42 : elite ? 37 : 24), 36, 4); g.fillStyle(0xff836f).fillRect(e.x - 18, e.y - (boss ? 42 : elite ? 37 : 24), 36 * e.hp / e.max, 4); }
        if ((e.kind === "charger" && e.clock < 0.65 && e.dash <= 0) || ((boss || elite) && e.clock < 0.5)) {
          g.lineStyle(2, 0xff7866, 0.7).strokeCircle(e.x, e.y, boss ? 44 : elite ? 38 : 25);
          g.lineBetween(e.x, e.y, r.player.x, r.player.y);
        }
      }
      for (const gem of r.gems) { g.fillStyle(0x61f2b8).fillTriangle(gem.x, gem.y - 5, gem.x - 4, gem.y, gem.x, gem.y + 5); g.fillTriangle(gem.x, gem.y - 5, gem.x + 4, gem.y, gem.x, gem.y + 5); }
      const direction = movement(), moving = !paused() && Math.hypot(direction.x, direction.y) > 0.05;
      this.combat.draw(r, direction, moving);
      for (const fx of r.effects) {
        if (fx.kind === "hit" || fx.kind === "kill") {
          if (!this.seen.has(fx)) {
            this.seen.add(fx);
            const text = this.add.text(fx.x, fx.y - 15, String(fx.value), { fontSize: "13px", fontFamily: "system-ui", color: "#fff0c8", stroke: "#18232d", strokeThickness: 3 }).setOrigin(0.5).setDepth(6);
            this.tweens.add({ targets: text, y: fx.y - 35, alpha: 0, duration: 350, onComplete: () => text.destroy() });
          }
        }
      }
      const frame = !reduced && moving ? 1 + Math.floor(r.time * 9) % 2 : 0;
      this.robot.setTexture(r.rig.robot === "scout" ? "survivor" : robotTexture.key, String(frame + (r.rig.robot === "engineer" ? 3 : 0)))
        .setDisplaySize(r.rig.robot === "bulwark" ? 49 : r.rig.robot === "engineer" ? 31 : 38, 46);
      this.shadow.setPosition(r.player.x, r.player.y + 20);
      this.robot.setPosition(r.player.x, r.player.y).setAlpha(r.invulnerable > 0 && Math.floor(r.time * 12) % 2 ? 0.5 : 1);
      const hp = this.health.clear(), hx = r.player.x - 22, hy = r.player.y - 34;
      hp.fillStyle(0x07151f, 0.95).fillRoundedRect(hx - 3, hy - 3, 50, 11, 3);
      const cells = maxHull(r), cellWidth = 44 / cells;
      for (let i = 0; i < cells; i++) hp.fillStyle(i < r.hull ? r.hull <= 2 ? 0xff8e7f : 0x79e4c4 : 0x354550).fillRect(hx + i * cellWidth, hy, Math.max(1, cellWidth - 1.5), 5);
      this.cameras.main.setScroll(r.player.x - W / 2, r.player.y - PLAYER_SCREEN_Y);
      if (r.hull < this.hull && !reduced) this.cameras.main.shake(100, 0.004);
      this.hull = r.hull;
    }
    update(_time: number, delta: number) {
      if (!this.paint) return;
      if (paused()) { this.elapsed = 0; this.draw(); return; }
      this.elapsed += Math.min(delta, 100) / 1000;
      while (this.elapsed >= STEP) { step(getRun(), movement()); this.elapsed -= STEP; }
      this.draw(); this.report += delta;
      if (this.report >= 100) { this.report = 0; onUpdate(); }
    }
  }
  const game = new Phaser.Game({ type: Phaser.AUTO, parent, width: W, height: H, transparent: true, scene: Survival,
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH }, audio: { noAudio: true }, banner: false,
    input: { keyboard: false, mouse: false, touch: false }, fps: { target: 60 } });
  const resize = new ResizeObserver(() => { if (game.isBooted) { game.scale.getParentBounds(); game.scale.refresh(); } });
  resize.observe(parent);
  return () => { cancelled = true; resize.disconnect(); game.destroy(true); };
}
