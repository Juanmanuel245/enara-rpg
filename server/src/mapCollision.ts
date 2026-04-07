import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

/** Mismo criterio que el cliente: césped interior en mapa-1. */
const WALKABLE_GID = 29;

let layer: number[] = [];
let tilesW = 30;
let tilesH = 21;
let tileW = 32;
let tileH = 32;

export let mapW = 30 * 32;
export let mapH = 21 * 32;
export const PLAYER_RADIUS = 18;

const __dirname = dirname(fileURLToPath(import.meta.url));

function resolveTmxPath(): string {
  const candidates = [
    join(__dirname, "..", "..", "client", "public", "mapas", "mapa-1.tmx"),
    join(__dirname, "..", "..", "mapas", "mapa-1.tmx"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    "No se encontró mapa-1.tmx (client/public/mapas/ o mapas/ en la raíz del repo).",
  );
}

function circleRectOverlap(
  cx: number,
  cy: number,
  r: number,
  rx: number,
  ry: number,
  rw: number,
  rh: number,
): boolean {
  const closestX = Math.max(rx, Math.min(cx, rx + rw));
  const closestY = Math.max(ry, Math.min(cy, ry + rh));
  const dx = cx - closestX;
  const dy = cy - closestY;
  return dx * dx + dy * dy <= r * r;
}

function tileSolid(tx: number, ty: number): boolean {
  if (tx < 0 || ty < 0 || tx >= tilesW || ty >= tilesH) return true;
  const gid = layer[ty * tilesW + tx];
  if (gid === 0) return false;
  return gid !== WALKABLE_GID;
}

/** True si el círculo intersecta algún tile no transitables. */
export function circleHitsSolid(cx: number, cy: number, r: number): boolean {
  if (cx - r < 0 || cx + r > mapW || cy - r < 0 || cy + r > mapH) return true;

  const minTx = Math.max(0, Math.floor((cx - r) / tileW));
  const maxTx = Math.min(tilesW - 1, Math.floor((cx + r) / tileW));
  const minTy = Math.max(0, Math.floor((cy - r) / tileH));
  const maxTy = Math.min(tilesH - 1, Math.floor((cy + r) / tileH));

  for (let ty = minTy; ty <= maxTy; ty++) {
    for (let tx = minTx; tx <= maxTx; tx++) {
      if (!tileSolid(tx, ty)) continue;
      const rx = tx * tileW;
      const ry = ty * tileH;
      if (circleRectOverlap(cx, cy, r, rx, ry, tileW, tileH)) return true;
    }
  }
  return false;
}

export function loadMapCollision(): void {
  const path = resolveTmxPath();
  const raw = readFileSync(path, "utf8");

  const mapTag = raw.match(/<map[^>]+>/)?.[0];
  if (!mapTag) throw new Error("TMX sin <map>");
  tilesW = Number(mapTag.match(/width="(\d+)"/)?.[1] ?? 30);
  tilesH = Number(mapTag.match(/height="(\d+)"/)?.[1] ?? 21);
  tileW = Number(mapTag.match(/tilewidth="(\d+)"/)?.[1] ?? 32);
  tileH = Number(mapTag.match(/tileheight="(\d+)"/)?.[1] ?? 32);
  mapW = tilesW * tileW;
  mapH = tilesH * tileH;

  const dataMatch = raw.match(/<data encoding="csv">([\s\S]*?)<\/data>/);
  if (!dataMatch) throw new Error("TMX sin <data encoding=\"csv\">");
  layer = dataMatch[1]
    .trim()
    .split(/[\s,]+/)
    .map((s) => Number.parseInt(s, 10));
  if (layer.length !== tilesW * tilesH) {
    throw new Error(`Capa CSV: ${layer.length} celdas, esperado ${tilesW}×${tilesH}`);
  }
}
