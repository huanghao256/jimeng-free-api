module.exports = {
  apps: [
    {
      name: "jimeng-api",
      script: "dist/index.js",
      interpreter: "node",
      node_args: "--enable-source-maps --no-node-snapshot",
      args: "--env prod",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 10,
      min_uptime: "10s",
      time: true,
      out_file: "./logs/pm2-out.log",
      error_file: "./logs/pm2-error.log",
      env: {
        NODE_ENV: "production",
        SERVER_ENV: "prod",
        SERVER_HOST: "0.0.0.0",
        SERVER_PORT: "5100",
        BROWSER_HEADLESS: "true",
        CLOAKBROWSER_AUTO_UPDATE: "false",
        // 填入代理地址可绕过数据中心IP风控，格式: http://user:pass@host:port
        // BROWSER_DEFAULT_PROXY: "http://user:pass@residential-proxy:port",
      },
    },
  ],
};
