const fs = require("fs");
const path = require("path");

/**
 * PM2: arranca el servidor (tras `npm run build` en ./server).
 * El puerto debe coincidir con "App Port" en CloudPanel (Nginx → 127.0.0.1:PUERTO).
 *
 * Orden de resolución (no uses solo `export PORT` con PM2: el loader del ecosystem
 * a menudo no hereda la shell):
 * 1) Archivo server/.port (una línea, ej: 3020)
 * 2) process.env.PORT
 * 3) 3000
 */
function readPort() {
  const fromFile = path.join(__dirname, "server", ".port");
  if (fs.existsSync(fromFile)) {
    const raw = fs.readFileSync(fromFile, "utf8").trim();
    const n = Number(raw);
    if (!Number.isNaN(n) && n > 0) return n;
  }
  const fromEnv = Number(process.env.PORT);
  if (!Number.isNaN(fromEnv) && fromEnv > 0) return fromEnv;
  return 3000;
}

const PORT = readPort();

module.exports = {
  apps: [
    {
      name: "juego-server",
      cwd: path.join(__dirname, "server"),
      script: "dist/index.js",
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        PORT,
      },
    },
  ],
};
