# No-Docker Production Deployment

This project can run directly as a Node.js service. The recommended production setup is:

- Node.js 18 or newer
- npm
- PM2
- Nginx or another reverse proxy
- A usable CloakBrowser/Chromium binary on the server

## 1. Install Runtime

Ubuntu/Debian example:

```bash
node -v
npm -v
npm install -g pm2
```

If the server has no browser runtime yet, install Chromium dependencies or a full Chromium package according to your OS. Then set one of these environment variables:

```bash
export CLOAKBROWSER_BINARY_PATH=/root/.cloakbrowser/chromium-146.0.7680.177.4/chrome
# or
export CHROME_EXECUTABLE_PATH=/usr/bin/chromium
```

`cloakbrowser` can also download its own Chromium into `~/.cloakbrowser`, but production servers often block external downloads, so a fixed binary path is more predictable.

## 2. Prepare Project

```bash
cd /www/wwwroot/jimeng-api
npm ci
npm run build
mkdir -p logs tmp data
```

Keep these directories persistent across releases:

- `data` stores the admin SQLite database.
- `logs` stores application and PM2 logs.
- `tmp` stores temporary uploads/files.

## 3. Start With PM2

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 status
pm2 logs jimeng-api
```

Enable boot startup:

```bash
pm2 startup
```

Run the command printed by PM2, then:

```bash
pm2 save
```

## 4. Health Check

```bash
curl http://127.0.0.1:5100/ping
```

If it fails, inspect:

```bash
pm2 logs jimeng-api --lines 100
```

## 5. Nginx Reverse Proxy

Example site config:

```nginx
server {
    listen 80;
    server_name your-domain.com;

    client_max_body_size 100m;

    location / {
        proxy_pass http://127.0.0.1:5100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
```

Then reload Nginx:

```bash
nginx -t
systemctl reload nginx
```

## 6. Updating

```bash
git pull
npm ci
npm run build
pm2 reload ecosystem.config.cjs --update-env
```

## Notes

- The production config is loaded from `configs/prod` because PM2 starts the app with `--env prod`.
- You can override host and port with `SERVER_HOST` and `SERVER_PORT`.
- Use `BROWSER_HEADLESS=true` on headless Linux servers.
- If browser startup fails, set `CLOAKBROWSER_BINARY_PATH` to an existing executable and restart with `pm2 reload ecosystem.config.cjs --update-env`.
