import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { randomUUID } from "crypto";
import { networkInterfaces } from "os";
import { existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import {
  circleHitsSolid,
  loadMapCollision,
  mapH,
  mapW,
  PLAYER_RADIUS,
} from "./mapCollision.js";

loadMapCollision();

const HOST = process.env.HOST ?? "0.0.0.0";

function lanIpv4Urls(port: number): string[] {
  const urls: string[] = [];
  for (const nets of Object.values(networkInterfaces())) {
    for (const net of nets ?? []) {
      const fam = net.family as string | number;
      const v4 = fam === "IPv4" || fam === 4;
      if (v4 && !net.internal) {
        urls.push(`http://${net.address}:${port}`);
      }
    }
  }
  return urls;
}

const PORT = Number(process.env.PORT) || 3000;
const PLAYER_SPEED = 220;
const TICK_MS = 50;
const MAX_HP = 100;

type InputState = { w: boolean; a: boolean; s: boolean; d: boolean };

/** 0 = sur, 1 = norte, 2 = este, 3 = oeste (coincide con filas del spritesheet de movimiento). */
type Player = {
  id: string;
  socketId: string;
  name: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  teamId: number;
  input: InputState;
  facing: number;
};

const players = new Map<string, Player>();

function spawnPosition(teamId: number): { x: number; y: number } {
  const margin = 80;
  const cx = mapW / 2;
  const cy = mapH / 2;
  const r = PLAYER_RADIUS;
  for (let i = 0; i < 80; i++) {
    let x: number;
    let y: number;
    if (teamId === 0) {
      x = margin + Math.random() * 200;
      y = cy + (Math.random() - 0.5) * 200;
    } else {
      x = mapW - margin - Math.random() * 200;
      y = cy + (Math.random() - 0.5) * 200;
    }
    x = Math.max(r, Math.min(mapW - r, x));
    y = Math.max(r, Math.min(mapH - r, y));
    if (!circleHitsSolid(x, y, r)) {
      return { x, y };
    }
  }
  return { x: cx, y: cy };
}

function emptyInput(): InputState {
  return { w: false, a: false, s: false, d: false };
}

function tick() {
  const dt = TICK_MS / 1000;
  const r = PLAYER_RADIUS;
  for (const p of players.values()) {
    let dx = 0;
    let dy = 0;
    if (p.input.w) dy -= 1;
    if (p.input.s) dy += 1;
    if (p.input.a) dx -= 1;
    if (p.input.d) dx += 1;
    const len = Math.hypot(dx, dy);
    if (len === 0) continue;
    if (Math.abs(dx) >= Math.abs(dy)) {
      p.facing = dx > 0 ? 2 : 3;
    } else {
      p.facing = dy > 0 ? 0 : 1;
    }
    dx /= len;
    dy /= len;
    const step = PLAYER_SPEED * dt;
    let nx = p.x + dx * step;
    let ny = p.y + dy * step;
    nx = Math.max(r, Math.min(mapW - r, nx));
    ny = Math.max(r, Math.min(mapH - r, ny));

    if (!circleHitsSolid(nx, ny, r)) {
      p.x = nx;
      p.y = ny;
    } else {
      if (!circleHitsSolid(nx, p.y, r)) p.x = nx;
      if (!circleHitsSolid(p.x, ny, r)) p.y = ny;
    }
  }
}

function snapshot() {
  return {
    map: { w: mapW, h: mapH },
    players: [...players.values()].map((p) => {
      let dx = 0;
      let dy = 0;
      if (p.input.w) dy -= 1;
      if (p.input.s) dy += 1;
      if (p.input.a) dx -= 1;
      if (p.input.d) dx += 1;
      const moving = Math.hypot(dx, dy) > 0;
      return {
        id: p.id,
        name: p.name,
        x: p.x,
        y: p.y,
        hp: p.hp,
        maxHp: p.maxHp,
        teamId: p.teamId,
        facing: p.facing,
        moving,
      };
    }),
  };
}

const app = express();
app.set("trust proxy", 1);

app.get("/health", (_req, res) => {
  res.json({ ok: true, players: players.size });
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const staticDir =
  process.env.STATIC_DIR ?? join(__dirname, "..", "..", "client", "dist");

if (existsSync(staticDir)) {
  app.use(express.static(staticDir));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/socket.io")) return next();
    res.sendFile(join(staticDir, "index.html"), (err) => {
      if (err) next(err);
    });
  });
}

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: true },
});

io.on("connection", (socket) => {
  socket.on(
    "join",
    (payload: { name?: string; teamId?: number }, ack?: (err?: string) => void) => {
      const existing = socket.data.playerId as string | undefined;
      if (existing) players.delete(existing);

      const name = (payload?.name ?? "Jugador").slice(0, 24) || "Jugador";
      const teamId = payload?.teamId === 1 ? 1 : 0;
      const id = randomUUID();
      const pos = spawnPosition(teamId);
      const player: Player = {
        id,
        socketId: socket.id,
        name,
        x: pos.x,
        y: pos.y,
        hp: MAX_HP,
        maxHp: MAX_HP,
        teamId,
        input: emptyInput(),
        facing: 0,
      };
      players.set(id, player);
      socket.data.playerId = id;
      socket.emit("joined", { playerId: id });
      io.emit("state", snapshot());
      ack?.();
    },
  );

  socket.on("input", (payload: Partial<InputState>) => {
    const id = socket.data.playerId as string | undefined;
    if (!id) return;
    const p = players.get(id);
    if (!p) return;
    const i = p.input;
    if (typeof payload.w === "boolean") i.w = payload.w;
    if (typeof payload.a === "boolean") i.a = payload.a;
    if (typeof payload.s === "boolean") i.s = payload.s;
    if (typeof payload.d === "boolean") i.d = payload.d;
  });

  socket.on("disconnect", () => {
    const id = socket.data.playerId as string | undefined;
    if (id && players.delete(id)) {
      io.emit("state", snapshot());
    }
  });
});

setInterval(() => {
  tick();
  io.emit("state", snapshot());
}, TICK_MS);

httpServer.listen(PORT, HOST, () => {
  console.log(`Servidor (API / WebSocket) escuchando en ${HOST}:${PORT}`);
  console.log(`  Local:    http://localhost:${PORT}`);
  for (const url of lanIpv4Urls(PORT)) {
    console.log(`  Red LAN:  ${url}`);
  }
  console.log(
    "  En otra PC de la misma red abre el cliente Vite (p. ej. http://TU_IP:5173), no esta URL directamente en dev.",
  );
});
