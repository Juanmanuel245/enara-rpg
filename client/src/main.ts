import { Application, Container, Graphics, Text } from "pixi.js";
import { io, Socket } from "socket.io-client";

type PlayerSnap = {
  id: string;
  name: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  teamId: number;
};

type StateMsg = {
  map: { w: number; h: number };
  players: PlayerSnap[];
};

const TEAM_COLORS = [0x3b82f6, 0xef4444];

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

const root = document.getElementById("app");
if (!root) throw new Error("#app no encontrado");

const app = new Application();
await app.init({
  resizeTo: window,
  background: 0x0d1117,
  antialias: true,
});
root.appendChild(app.canvas as HTMLCanvasElement);

const world = new Container();
app.stage.addChild(world);

const grid = new Graphics();
world.addChild(grid);

const sprites = new Map<string, { g: Graphics; label: Text }>();

let mapW = 2000;
let mapH = 2000;

function drawGrid() {
  grid.clear();
  const step = 100;
  grid.stroke({ width: 1, color: 0x21262d, alpha: 0.6 });
  for (let x = 0; x <= mapW; x += step) {
    grid.moveTo(x, 0);
    grid.lineTo(x, mapH);
  }
  for (let y = 0; y <= mapH; y += step) {
    grid.moveTo(0, y);
    grid.lineTo(mapW, y);
  }
  grid.stroke();
}

drawGrid();

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

const socket: Socket = io({
  path: "/socket.io",
  transports: ["websocket"],
});

const teamId = Math.random() < 0.5 ? 0 : 1;

socket.on("connect", () => {
  socket.emit("join", { name: playerName, teamId });
  hud.text = `${playerName} · equipo ${teamId + 1} · WASD`;
});

socket.on("state", (data: StateMsg) => {
  mapW = data.map.w;
  mapH = data.map.h;
  drawGrid();

  const seen = new Set<string>();
  for (const p of data.players) {
    seen.add(p.id);
    let entry = sprites.get(p.id);
    if (!entry) {
      const g = new Graphics();
      const label = new Text({
        text: p.name,
        style: {
          fill: 0xffffff,
          fontSize: 12,
          fontFamily: "system-ui, sans-serif",
        },
      });
      label.anchor.set(0.5, 1.5);
      world.addChild(g);
      world.addChild(label);
      entry = { g, label };
      sprites.set(p.id, entry);
    }
    const color = TEAM_COLORS[p.teamId % TEAM_COLORS.length];
    entry.g.clear();
    entry.g.circle(0, 0, 18);
    entry.g.fill(color);
    entry.g.stroke({ width: 2, color: 0xffffff, alpha: 0.35 });
    entry.g.position.set(p.x, p.y);
    entry.label.position.set(p.x, p.y - 22);
    entry.label.text = `${p.name}  ${p.hp}/${p.maxHp}`;
  }

  for (const [id, s] of sprites) {
    if (!seen.has(id)) {
      world.removeChild(s.g);
      world.removeChild(s.label);
      s.g.destroy();
      s.label.destroy();
      sprites.delete(id);
    }
  }
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
  world.scale.set(app.renderer.width / mapW, app.renderer.height / mapH);
});
}

bootstrap().catch((err) => console.error(err));
