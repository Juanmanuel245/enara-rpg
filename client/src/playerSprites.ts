import { Texture } from "pixi.js";

/**
 * Formato Argentum Online (clásico):
 * - Cabeza: 128×128 → rejilla 4×4 de celdas 32×32 (fila 0 = 4 vistas: frente, costados, espalda).
 * - Ropa en movimiento: 256×256 → celdas 32×64 (8 columnas × 4 filas = sur, norte, oeste, este).
 * - Ropa quieto: un solo frame (p. ej. 32×32).
 */
export const HEAD_SIZE = 32;
export const MOVE_FRAME_W = 32;
export const MOVE_FRAME_H = 64;

/** Frames de caminata por fila (AO: 6 frente/espalda, 5 perfiles). */
export const FRAMES_PER_FACING = [6, 6, 5, 5] as const;

/** En AO el orden de filas en el BMP suele ser Sur, Norte, Oeste, Este (no E/O como en el eje X). */
export const AO_BODY_ROW_FOR_FACING: readonly [number, number, number, number] = [0, 1, 3, 2];

/** Ancla pies → base del cuello (cuerpo idle 32px; movimiento 64px). */
export const HEAD_OFFSET_IDLE = 32;
export const HEAD_OFFSET_MOVE = 56;

export type PlayerTextureSet = {
  idleBody: Texture;
  moveFrames: Texture[][];
  headByCol: Texture[];
};

/**
 * Columna en `cabeza.png` (fila 0) según `facing` del servidor.
 * Hoja: frente, derecha, izquierda, atrás.
 */
export function headColumnForFacing(facing: number): number {
  const f = ((facing % 4) + 4) % 4;
  if (f === 0) return 0;
  if (f === 1) return 3;
  if (f === 2) return 1;
  return 2;
}

/** Solo el negro de fondo conectado a los bordes; no borra contornos negros cerrados dentro del personaje. */
function floodClearBackgroundBlack(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const d = ctx.getImageData(0, 0, w, h);
  const data = d.data;
  const isBg = (i: number) =>
    data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 255;

  const visited = new Uint8Array(w * h);
  const q: number[] = [];

  const push = (x: number, y: number) => {
    const p = y * w + x;
    if (x < 0 || y < 0 || x >= w || y >= h || visited[p]) return;
    const i = p << 2;
    if (!isBg(i)) return;
    visited[p] = 1;
    q.push(p);
  };

  for (let x = 0; x < w; x++) {
    push(x, 0);
    push(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    push(0, y);
    push(w - 1, y);
  }

  while (q.length) {
    const p = q.pop()!;
    const i = p << 2;
    data[i + 3] = 0;
    const x = p % w;
    const y = (p / w) | 0;
    push(x + 1, y);
    push(x - 1, y);
    push(x, y + 1);
    push(x, y - 1);
  }

  ctx.putImageData(d, 0, 0);
}

function prepareCanvasFromImage(bmp: ImageBitmap): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bmp, 0, 0);
  floodClearBackgroundBlack(ctx, canvas.width, canvas.height);
  return canvas;
}

function textureFromCrop(source: HTMLCanvasElement, x: number, y: number, w: number, h: number): Texture {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(source, x, y, w, h, 0, 0, w, h);
  const tex = Texture.from(c);
  tex.source.scaleMode = "nearest";
  tex.source.autoGenerateMipmaps = false;
  return tex;
}

async function loadImageCanvas(url: string): Promise<HTMLCanvasElement> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`No se pudo cargar ${url}`);
  const blob = await res.blob();
  const bmp = await createImageBitmap(blob);
  const canvas = prepareCanvasFromImage(bmp);
  bmp.close();
  return canvas;
}

export async function loadPlayerTextures(baseUrl: string): Promise<PlayerTextureSet> {
  const root = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const idleCanvas = await loadImageCanvas(`${root}ropa/ropa_comun.png`);
  const moveCanvas = await loadImageCanvas(`${root}ropa/ropa_comun_movimiento.png`);
  const headCanvas = await loadImageCanvas(`${root}cabezas/cabeza.png`);

  const idleBody = textureFromCrop(idleCanvas, 0, 0, idleCanvas.width, idleCanvas.height);

  const moveFrames: Texture[][] = [[], [], [], []];
  for (let facing = 0; facing < 4; facing++) {
    const sheetRow = AO_BODY_ROW_FOR_FACING[facing];
    const n = FRAMES_PER_FACING[facing];
    for (let fi = 0; fi < n; fi++) {
      moveFrames[facing].push(
        textureFromCrop(
          moveCanvas,
          fi * MOVE_FRAME_W,
          sheetRow * MOVE_FRAME_H,
          MOVE_FRAME_W,
          MOVE_FRAME_H,
        ),
      );
    }
  }

  const headByCol: Texture[] = [];
  for (let c = 0; c < 4; c++) {
    headByCol.push(textureFromCrop(headCanvas, c * HEAD_SIZE, 0, HEAD_SIZE, HEAD_SIZE));
  }

  return { idleBody, moveFrames, headByCol };
}
