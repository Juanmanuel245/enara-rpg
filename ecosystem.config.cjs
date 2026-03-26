const path = require("path");

/** PM2: arranca el servidor de juego (tras `npm run build` en ./server). */
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
        PORT: 3000,
      },
    },
  ],
};
