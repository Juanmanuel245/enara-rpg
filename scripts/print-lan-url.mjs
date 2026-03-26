import { networkInterfaces } from "node:os";

const PORT = Number(process.env.VITE_PORT) || 5173;

/** @param {number} port */
function lanUrls(port) {
  const urls = [];
  for (const nets of Object.values(networkInterfaces())) {
    for (const net of nets ?? []) {
      const fam = /** @type {string | number} */ (net.family);
      const v4 = fam === "IPv4" || fam === 4;
      if (v4 && !net.internal) {
        urls.push(`http://${net.address}:${port}`);
      }
    }
  }
  return urls;
}

const urls = lanUrls(PORT);
const lines = [
  "",
  "  ─────────────────────────────────────────────",
  "  Juego · modo desarrollo",
  "  En otra PC de la misma red abre una de estas URLs en el navegador:",
];

if (urls.length === 0) {
  lines.push("    (no se detectó IPv4 en LAN; mira la línea «Network» de Vite)");
} else {
  for (const u of urls) lines.push(`    ${u}`);
}

lines.push(
  "  El servidor de juego usa el puerto 3000; Vite hace de proxy a Socket.IO.",
  "  ─────────────────────────────────────────────",
  "",
);

console.log(lines.join("\n"));
