const path = require("node:path");

module.exports = {
  apps: [
    {
      name: "siberslice",
      script: path.join(__dirname, "packages/web/src/server/index.js"),
      cwd: __dirname,
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      time: true,
      env: {
        NODE_ENV: "production",
        SIBERSLICE_PORT: "8200",
      },
    },
  ],
};
