# Nocturne Feedback Relay

Лёгкий релей без сторонних npm-пакетов: принимает отчёты и логи из Nocturne по `POST /nocturne-feedback` и отправляет их в Telegram от вашего бота, скрывая ваш личный аккаунт и токен.

## Установка на VPS (где уже работает Caddy с HTTPS на 64.188.95.211)

1. Проверьте, что установлен Node.js 18+ (`node -v`). Если нет:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
   ```
2. Скопируйте `server.mjs` и создайте `.env`:
   ```bash
   mkdir -p /opt/nocturne-feedback
   cp server.mjs /opt/nocturne-feedback/server.mjs
   cp .env.example /opt/nocturne-feedback/.env
   chmod 600 /opt/nocturne-feedback/.env
   nano /opt/nocturne-feedback/.env   # впишите TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID
   ```
   *(Узнать `TELEGRAM_CHAT_ID` можно у бота `@userinfobot`, затем обязательно напишите `/start` своему созданному боту, иначе Telegram запретит боту писать вам первым.)*
3. Запустите systemd-сервис:
   ```bash
   cp nocturne-feedback.service /etc/systemd/system/nocturne-feedback.service
   systemctl daemon-reload
   systemctl enable --now nocturne-feedback
   curl http://127.0.0.1:8787/health
   ```
4. Пробросьте маршрут в существующем `/etc/caddy/Caddyfile` внутри блока `64.188.95.211` (перед остальными правилами Lyra):
   ```caddyfile
   handle /nocturne-feedback* {
       reverse_proxy 127.0.0.1:8787
   }
   ```
   И перезагрузите Caddy:
   ```bash
   caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy
   ```
