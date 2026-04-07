import { Application, Container, Graphics, Sprite, Text, Texture } from "pixi.js";
import { io, Socket } from "socket.io-client";
import {
  FRAMES_PER_FACING,
  HEAD_OFFSET_IDLE,
  HEAD_OFFSET_MOVE,
  HEAD_SIZE,
  headColumnForFacing,
  loadPlayerTextures,
} from "./playerSprites";
import { loadTiledMap } from "./tmx";
import type { TiledMapResult } from "./tmx";

type PlayerSnap = {
  id: string;
  name: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  teamId: number;
  facing: number;
  moving: boolean;
};

type StateMsg = {
  map: { w: number; h: number };
  players: PlayerSnap[];
};

const TEAM_COLORS = [0x3b82f6, 0xef4444];

/** Vista 2D ortográfica: mismas unidades que el servidor (px de mundo). */
function worldToScreen(wx: number, wy: number, zoom: number): { x: number; y: number } {
  return { x: wx * zoom, y: wy * zoom };
}

function makeVignetteTexture(w: number, h: number): Texture {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.floor(w));
  c.height = Math.max(1, Math.floor(h));
  const ctx = c.getContext("2d")!;
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.hypot(w, h) * 0.52;
  const grd = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  grd.addColorStop(0, "rgba(0,0,0,0)");
  grd.addColorStop(0.55, "rgba(0,0,0,0.25)");
  grd.addColorStop(1, "rgba(0,0,0,0.82)");
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, w, h);
  return Texture.from(c);
}

function askPlayerName(): Promise<string> {
  return new Promise((resolve) => {
    const screen = document.getElementById("name-screen");
    const form = document.getElementById("name-form") as HTMLFormElement | null;
    const input = document.getElementById("player-name") as HTMLInputElement | null;
    const err = document.getElementById("name-error");
    if (!screen || !form || !input || !err) {
      resolve(`Heroe_${Math.floor(Math.random() * 999)}`);
      return;
    }
    const showError = (msg: string) => {
      err.hidden = false;
      err.textContent = msg;
    };
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const raw = input.value.trim();
      if (!raw) {
        showError("Escribe un nombre para tu personaje.");
        input.focus();
        return;
      }
      err.hidden = true;
      screen.classList.add("hidden");
      resolve(raw.slice(0, 24));
    });
  });
}

async function bootstrap() {
  const playerName = await askPlayerName();

  /** Solo depuración: añade `?debugCollision` a la URL para ver puntos/rects de colisión. */
  const debugCollision =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).has("debugCollision");

  const root = document.getElementById("app");
  if (!root) throw new Error("#app no encontrado");

  const app = new Application();
  await app.init({
    resizeTo: window,
    /** Un poco más claro que el verde muy oscuro: el negro del tileset (#000) casi no se veía. */
    background: 0x3a4f42,
    antialias: true,
  });
  root.appendChild(app.canvas as HTMLCanvasElement);

  const baseUrl = import.meta.env.BASE_URL;
  const texSet = await loadPlayerTextures(baseUrl);

  const world = new Container();
  world.sortableChildren = true;
  app.stage.addChild(world);

  const mapTiles = new Container();
  mapTiles.sortableChildren = true;
  mapTiles.zIndex = 0;
  world.addChild(mapTiles);

  const collisionOverlay = new Graphics();
  collisionOverlay.zIndex = 5000;
  world.addChild(collisionOverlay);

  const grid = new Graphics();
  grid.zIndex = 5100;
  world.addChild(grid);

  type PlayerEntry = { container: Container; body: Sprite; head: Sprite; label: Text };
  const sprites = new Map<string, PlayerEntry>();

  let mapW = 30 * 32;
  let mapH = 21 * 32;
  let myPlayerId: string | null = null;
  let lastState: StateMsg | null = null;
  let tiledMap: TiledMapResult | null = null;
  let lastMapZoom = -1;

  function viewZoom(): number {
    return Math.min(app.renderer.width, app.renderer.height) / 640;
  }

  function rebuildMapTiles() {
    if (!tiledMap) return;
    const z = viewZoom();
    if (z === lastMapZoom && mapTiles.children.length > 0) return;
    lastMapZoom = z;
    mapTiles.removeChildren().forEach((c) => c.destroy({ children: true }));

    const layer = tiledMap.layers[0];
    const tw = tiledMap.tileWidth;
    const th = tiledMap.tileHeight;

    for (let ty = 0; ty < tiledMap.height; ty++) {
      for (let tx = 0; tx < tiledMap.width; tx++) {
        const gid = layer.data[ty * tiledMap.width + tx];
        const tex = tiledMap.textureForGid(gid);
        if (!tex) continue;
        const sprite = new Sprite(tex);
        sprite.anchor.set(0, 0);
        sprite.position.set(tx * tw * z, ty * th * z);
        sprite.scale.set(z);
        sprite.zIndex = ty * tiledMap.width + tx;
        mapTiles.addChild(sprite);
      }
    }
    rebuildCollisionOverlay();
  }

  function rebuildCollisionOverlay() {
    if (!debugCollision || !tiledMap) {
      collisionOverlay.clear();
      return;
    }
    const z = viewZoom();
    collisionOverlay.clear();
    const r = Math.max(2, 3 * z);
    for (const p of tiledMap.collisionPoints) {
      const s = worldToScreen(p.x, p.y, z);
      collisionOverlay.circle(s.x, s.y, r);
      collisionOverlay.fill({ color: 0xf97316, alpha: 0.92 });
      collisionOverlay.stroke({ width: Math.max(1, z), color: 0x1c1917, alpha: 0.45 });
    }
    for (const rect of tiledMap.collisionRects) {
      const o = worldToScreen(rect.x, rect.y, z);
      collisionOverlay.rect(o.x, o.y, rect.w * z, rect.h * z);
      collisionOverlay.stroke({ width: Math.max(1, z), color: 0xf97316, alpha: 0.85 });
    }
  }

  function drawGrid() {
    if (tiledMap) {
      grid.clear();
      return;
    }
    const z = viewZoom();
    grid.clear();
    grid.stroke({ width: 1, color: 0x2d4a32, alpha: 0.75 });
    const step = 100;
    for (let x = 0; x <= mapW; x += step) {
      const a = worldToScreen(x, 0, z);
      const b = worldToScreen(x, mapH, z);
      grid.moveTo(a.x, a.y);
      grid.lineTo(b.x, b.y);
    }
    for (let y = 0; y <= mapH; y += step) {
      const a = worldToScreen(0, y, z);
      const b = worldToScreen(mapW, y, z);
      grid.moveTo(a.x, a.y);
      grid.lineTo(b.x, b.y);
    }
    grid.stroke();
  }

  function syncPlayerSprites() {
    if (!lastState) return;
    const animT = Math.floor(performance.now() / 130);
    for (const p of lastState.players) {
      const vis = sprites.get(p.id);
      if (!vis) continue;
      const facing = ((p.facing % 4) + 4) % 4;
      vis.head.texture = texSet.headByCol[headColumnForFacing(facing)];
      if (p.moving) {
        const n = FRAMES_PER_FACING[facing];
        vis.body.texture = texSet.moveFrames[facing][animT % n];
        vis.head.position.set(0, -HEAD_OFFSET_MOVE);
        vis.label.position.set(0, -HEAD_OFFSET_MOVE - HEAD_SIZE - 4);
      } else {
        vis.body.texture = texSet.idleBody;
        vis.head.position.set(0, -HEAD_OFFSET_IDLE);
        vis.label.position.set(0, -HEAD_OFFSET_IDLE - HEAD_SIZE - 4);
      }
    }
  }

  function paintState(data: StateMsg) {
    mapW = data.map.w;
    mapH = data.map.h;
    drawGrid();

    const seen = new Set<string>();
    const z = viewZoom();
    for (const p of data.players) {
      seen.add(p.id);
      let entry = sprites.get(p.id);
      if (!entry) {
        const container = new Container();
        const label = new Text({
          text: p.name,
          style: {
            fill: 0xffffff,
            fontSize: 12,
            fontFamily: "system-ui, sans-serif",
          },
        });
        label.anchor.set(0.5, 1);
        const body = new Sprite(texSet.idleBody);
        body.anchor.set(0.5, 1);
        const head = new Sprite(texSet.headByCol[headColumnForFacing(0)]);
        head.anchor.set(0.5, 1);
        head.position.set(0, -HEAD_OFFSET_IDLE);
        label.position.set(0, -HEAD_OFFSET_IDLE - HEAD_SIZE - 4);
        container.addChild(body);
        container.addChild(head);
        container.addChild(label);
        world.addChild(container);
        entry = { container, body, head, label };
        sprites.set(p.id, entry);
      }
      const teamColor = TEAM_COLORS[p.teamId % TEAM_COLORS.length];
      entry.label.style.fill = teamColor;
      entry.label.text = `${p.name}  ${p.hp}/${p.maxHp}`;
      const sp = worldToScreen(p.x, p.y, z);
      entry.container.position.set(sp.x, sp.y);
      entry.container.scale.set(z);
      entry.container.zIndex = 100_000 + Math.round(p.y * 1000);
    }

    for (const [id, s] of sprites) {
      if (!seen.has(id)) {
        world.removeChild(s.container);
        s.container.destroy({ children: true });
        sprites.delete(id);
      }
    }

    const me = myPlayerId ? data.players.find((p) => p.id === myPlayerId) : undefined;
    if (me) {
      const sp = worldToScreen(me.x, me.y, z);
      world.position.set(
        app.renderer.width * 0.5 - sp.x,
        app.renderer.height * 0.5 - sp.y,
      );
    } else {
      const sp = worldToScreen(mapW * 0.5, mapH * 0.5, z);
      world.position.set(app.renderer.width * 0.5 - sp.x, app.renderer.height * 0.5 - sp.y);
    }
  }

  try {
    tiledMap = await loadTiledMap(`${baseUrl}mapas/mapa-1.tmx`);
    rebuildMapTiles();
  } catch (err) {
    console.warn("No se cargó el mapa TMX (¿falta Terreno-1.png en client/public/mapas/?):", err);
    drawGrid();
  }

  const hud = new Text({
    text: "Conectando…",
    style: {
      fill: 0xe6edf3,
      fontSize: 14,
      fontFamily: "system-ui, sans-serif",
    },
  });
  hud.position.set(12, 12);
  app.stage.addChild(hud);

  const vignette = new Sprite();
  vignette.eventMode = "none";
  let vignetteSize = { w: 0, h: 0 };
  function syncVignette() {
    const w = app.renderer.width;
    const h = app.renderer.height;
    if (w === vignetteSize.w && h === vignetteSize.h) return;
    vignetteSize = { w, h };
    if (vignette.texture) vignette.texture.destroy(true);
    vignette.texture = makeVignetteTexture(w, h);
    vignette.width = w;
    vignette.height = h;
  }
  syncVignette();
  app.stage.addChild(vignette);

  const socket: Socket = io({
    path: "/socket.io",
    transports: ["websocket"],
  });

  const teamId = Math.random() < 0.5 ? 0 : 1;

  socket.on("joined", (data: { playerId: string }) => {
    if (data?.playerId) myPlayerId = data.playerId;
  });

  socket.on("connect", () => {
    socket.emit("join", { name: playerName, teamId });
    hud.text = `${playerName} · equipo ${teamId + 1} · WASD · vista 2D`;
  });

  socket.on("state", (data: StateMsg) => {
    lastState = data;
    paintState(data);
  });

  window.addEventListener("resize", () => {
    syncVignette();
    rebuildMapTiles();
    rebuildCollisionOverlay();
    if (lastState) paintState(lastState);
  });

  const keys = { w: false, a: false, s: false, d: false };

  window.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    if (k === "w" || k === "a" || k === "s" || k === "d") {
      keys[k] = true;
      socket.emit("input", { ...keys });
    }
  });

  window.addEventListener("keyup", (e) => {
    const k = e.key.toLowerCase();
    if (k === "w" || k === "a" || k === "s" || k === "d") {
      keys[k] = false;
      socket.emit("input", { ...keys });
    }
  });

  app.ticker.add(() => {
    syncVignette();
    syncPlayerSprites();
  });
}

bootstrap().catch((err) => console.error(err));
