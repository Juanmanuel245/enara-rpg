import { Rectangle, Texture } from "pixi.js";

async function loadTextureFromUrl(url: string): Promise<Texture> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Imagen no cargada (${res.status}): ${url}`);
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob);
  return Texture.from(bitmap);
}

export type CollisionRect = { x: number; y: number; w: number; h: number };

export type TiledMapResult = {
  width: number;
  height: number;
  tileWidth: number;
  tileHeight: number;
  pixelWidth: number;
  pixelHeight: number;
  layers: { name: string; data: number[] }[];
  textureForGid: (gid: number) => Texture | null;
  /** Puntos de colisión en coordenadas de mundo (px), p. ej. centro de tiles sólidos o objetos tipo point. */
  collisionPoints: { x: number; y: number }[];
  /** Rectángulos de objetos del mapa o colisiones por tile en el tileset. */
  collisionRects: CollisionRect[];
};

function parseXml(text: string): Document {
  const p = new DOMParser();
  const doc = p.parseFromString(text, "application/xml");
  const err = doc.querySelector("parsererror");
  if (err) throw new Error("XML inválido");
  return doc;
}

function resolveUrl(base: string, relative: string): string {
  const origin = typeof window !== "undefined" ? window.location.href : "http://localhost/";
  const absBase = base.startsWith("http") ? base : new URL(base, origin).href;
  return new URL(relative, absBase).href;
}

function parseCsvData(text: string): number[] {
  return text
    .trim()
    .split(/[\s,]+/)
    .filter((s) => s.length > 0)
    .map((s) => Number.parseInt(s, 10));
}

function parseObjectGroupsFromMap(doc: Document): {
  points: { x: number; y: number }[];
  rects: CollisionRect[];
} {
  const points: { x: number; y: number }[] = [];
  const rects: CollisionRect[] = [];

  for (const og of doc.querySelectorAll("map > objectgroup")) {
    for (const obj of og.querySelectorAll("object")) {
      const x = Number(obj.getAttribute("x") ?? 0);
      const y = Number(obj.getAttribute("y") ?? 0);
      const w = Number(obj.getAttribute("width") ?? 0);
      const h = Number(obj.getAttribute("height") ?? 0);
      const hasPoint = obj.querySelector("point");

      const poly = obj.querySelector("polygon");
      if (poly) {
        const raw = poly.getAttribute("points")?.trim() ?? "";
        for (const pair of raw.split(/\s+/)) {
          if (!pair) continue;
          const [px, py] = pair.split(",").map((n) => Number(n));
          if (Number.isFinite(px) && Number.isFinite(py)) {
            points.push({ x: x + px, y: y + py });
          }
        }
        continue;
      }

      const line = obj.querySelector("polyline");
      if (line) {
        const raw = line.getAttribute("points")?.trim() ?? "";
        for (const pair of raw.split(/\s+/)) {
          if (!pair) continue;
          const [px, py] = pair.split(",").map((n) => Number(n));
          if (Number.isFinite(px) && Number.isFinite(py)) {
            points.push({ x: x + px, y: y + py });
          }
        }
        continue;
      }

      if (hasPoint || (w === 0 && h === 0)) {
        points.push({ x, y });
        continue;
      }

      if (w > 0 && h > 0) {
        rects.push({ x, y, w, h });
      }
    }
  }

  return { points, rects };
}

/** Centro de cada celda cuyo gid no es vacío ni “césped / transitable”. */
function inferCollisionFromTileLayer(
  layer: { data: number[] },
  mapW: number,
  mapH: number,
  tileW: number,
  tileH: number,
  walkableGids: Set<number>,
): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let ty = 0; ty < mapH; ty++) {
    for (let tx = 0; tx < mapW; tx++) {
      const gid = layer.data[ty * mapW + tx];
      if (gid === 0) continue;
      if (walkableGids.has(gid)) continue;
      out.push({ x: tx * tileW + tileW * 0.5, y: ty * tileH + tileH * 0.5 });
    }
  }
  return out;
}

type TilesetCollisionEntry = { rects: CollisionRect[]; points: { x: number; y: number }[] };

function parseTileCollisionsFromTsxDoc(doc: Document): Map<number, TilesetCollisionEntry> {
  const byLocalId = new Map<number, TilesetCollisionEntry>();

  for (const tileEl of doc.querySelectorAll("tileset > tile")) {
    const id = Number(tileEl.getAttribute("id") ?? -1);
    if (id < 0) continue;
    const og = tileEl.querySelector("objectgroup");
    if (!og) continue;
    let entry = byLocalId.get(id);
    if (!entry) {
      entry = { rects: [], points: [] };
      byLocalId.set(id, entry);
    }
    for (const obj of og.querySelectorAll("object")) {
      const ox = Number(obj.getAttribute("x") ?? 0);
      const oy = Number(obj.getAttribute("y") ?? 0);
      const w = Number(obj.getAttribute("width") ?? 0);
      const h = Number(obj.getAttribute("height") ?? 0);
      const hasPoint = obj.querySelector("point");
      if (hasPoint || (w === 0 && h === 0)) {
        entry.points.push({ x: ox, y: oy });
      } else if (w > 0 && h > 0) {
        entry.rects.push({ x: ox, y: oy, w, h });
      }
    }
  }

  return byLocalId;
}

type TilesetInfo = {
  firstgid: number;
  tileW: number;
  tileH: number;
  margin: number;
  spacing: number;
  columns: number;
  tilecount: number;
  textures: Texture[];
  /** id local del tile (0-based) → colisiones definidas en el TSX */
  tileCollisions: Map<number, TilesetCollisionEntry>;
};

async function loadTilesetFromTsx(tsxUrl: string): Promise<TilesetInfo> {
  const res = await fetch(tsxUrl);
  if (!res.ok) throw new Error(`No se pudo cargar tileset: ${tsxUrl}`);
  const doc = parseXml(await res.text());
  const ts = doc.querySelector("tileset");
  if (!ts) throw new Error("tileset no encontrado en TSX");

  const tileW = Number(ts.getAttribute("tilewidth") ?? 32);
  const tileH = Number(ts.getAttribute("tileheight") ?? 32);
  const margin = Number(ts.getAttribute("margin") ?? 0);
  const spacing = Number(ts.getAttribute("spacing") ?? 0);
  const columns = Number(ts.getAttribute("columns") ?? 1);
  const tilecount = Number(ts.getAttribute("tilecount") ?? 0);

  const imgEl = ts.querySelector("image");
  const src = imgEl?.getAttribute("source");
  if (!src) throw new Error("TSX sin <image source=\"...\">");

  const imageUrl = resolveUrl(tsxUrl, src);
  const base = await loadTextureFromUrl(imageUrl);

  const textures: Texture[] = [];
  for (let i = 0; i < tilecount; i++) {
    const col = i % columns;
    const row = Math.floor(i / columns);
    const x = margin + col * (tileW + spacing);
    const y = margin + row * (tileH + spacing);
    textures.push(
      new Texture({
        source: base.source,
        frame: new Rectangle(x, y, tileW, tileH),
      }),
    );
  }

  const tileCollisions = parseTileCollisionsFromTsxDoc(doc);

  return {
    firstgid: 0,
    tileW,
    tileH,
    margin,
    spacing,
    columns,
    tilecount,
    textures,
    tileCollisions,
  };
}

/**
 * Carga un mapa Tiled (.tmx) con tileset externo (.tsx) e imagen referenciada en el TSX.
 * Coloca mapa, tsx e imagen en `public/mapas/` (servidos como `/mapas/...`).
 */
export async function loadTiledMap(tmxUrl: string): Promise<TiledMapResult> {
  const res = await fetch(tmxUrl);
  if (!res.ok) throw new Error(`No se pudo cargar el mapa: ${tmxUrl}`);
  const doc = parseXml(await res.text());
  const mapEl = doc.querySelector("map");
  if (!mapEl) throw new Error("<map> no encontrado");

  const width = Number(mapEl.getAttribute("width") ?? 0);
  const height = Number(mapEl.getAttribute("height") ?? 0);
  const tileWidth = Number(mapEl.getAttribute("tilewidth") ?? 32);
  const tileHeight = Number(mapEl.getAttribute("tileheight") ?? 32);

  const tilesetEls = [...doc.querySelectorAll("map > tileset")];
  const tilesets: TilesetInfo[] = [];

  for (const el of tilesetEls) {
    const firstgid = Number(el.getAttribute("firstgid") ?? 1);
    const source = el.getAttribute("source");
    if (!source) continue;
    const tsxUrl = resolveUrl(tmxUrl, source);
    const info = await loadTilesetFromTsx(tsxUrl);
    info.firstgid = firstgid;
    tilesets.push(info);
  }

  if (tilesets.length === 0) throw new Error("El mapa no tiene tilesets externos con source");

  const layers: { name: string; data: number[] }[] = [];
  for (const layer of doc.querySelectorAll("layer")) {
    const name = layer.getAttribute("name") ?? "layer";
    const dataEl = layer.querySelector("data");
    const enc = dataEl?.getAttribute("encoding");
    const raw = dataEl?.textContent ?? "";
    if (enc !== "csv") {
      throw new Error(`Capa "${name}": solo se admite data encoding="csv"`);
    }
    const data = parseCsvData(raw);
    if (data.length !== width * height) {
      throw new Error(
        `Capa "${name}": el CSV tiene ${data.length} celdas pero el mapa es ${width}×${height}=${width * height}. En Tiled revisa que width/height coincidan con las filas/columnas del CSV.`,
      );
    }
    layers.push({ name, data });
  }

  if (layers.length === 0) throw new Error("El mapa no tiene capas de tiles");

  function textureForGid(gid: number): Texture | null {
    if (gid === 0) return null;
    for (const ts of tilesets) {
      if (gid >= ts.firstgid && gid < ts.firstgid + ts.tilecount) {
        const local = gid - ts.firstgid;
        return ts.textures[local] ?? null;
      }
    }
    return null;
  }

  const { points: objectPoints, rects: objectRects } = parseObjectGroupsFromMap(doc);

  /** En mapa-1 el césped interior usa gid 29; el resto de tiles con imagen son bordes/muros. */
  const walkableGids = new Set([29]);
  const inferredPoints =
    layers.length > 0
      ? inferCollisionFromTileLayer(layers[0], width, height, tileWidth, tileHeight, walkableGids)
      : [];

  const tilesetPoints: { x: number; y: number }[] = [];
  const tilesetRects: CollisionRect[] = [];
  const baseLayer = layers[0];
  if (baseLayer) {
    for (let ty = 0; ty < height; ty++) {
      for (let tx = 0; tx < width; tx++) {
        const gid = baseLayer.data[ty * width + tx];
        if (gid === 0) continue;
        for (const ts of tilesets) {
          if (gid < ts.firstgid || gid >= ts.firstgid + ts.tilecount) continue;
          const local = gid - ts.firstgid;
          const entry = ts.tileCollisions.get(local);
          if (!entry) break;
          const ox = tx * tileWidth;
          const oy = ty * tileHeight;
          for (const p of entry.points) {
            tilesetPoints.push({ x: ox + p.x, y: oy + p.y });
          }
          for (const r of entry.rects) {
            tilesetRects.push({ x: ox + r.x, y: oy + r.y, w: r.w, h: r.h });
          }
          break;
        }
      }
    }
  }

  const collisionPoints = [...objectPoints, ...inferredPoints, ...tilesetPoints];
  const collisionRects = [...objectRects, ...tilesetRects];

  return {
    width,
    height,
    tileWidth,
    tileHeight,
    pixelWidth: width * tileWidth,
    pixelHeight: height * tileHeight,
    layers,
    textureForGid,
    collisionPoints,
    collisionRects,
  };
}
