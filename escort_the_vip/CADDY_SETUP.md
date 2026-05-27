# Запуск Colyseus + Caddy

- [1. Підготовка домену DuckDNS](#1-підготовка-домену-duckdns)
- [2. Установка Caddy](#2-установка-caddy)
  - [Windows](#windows)
  - [Linux](#linux)
- [3. Налаштування Caddyfile](#3-налаштування-caddyfile)
- [4. Запуск](#4-запуск)
- [5. Підключення з клієнта](#5-підключення-з-клієнта)
- [Приклади Caddyfile для різних випадків](#приклади-caddyfile-для-різних-випадків)
- [Поширені проблеми](#поширені-проблеми)

---

## 1. Підготовка домену DuckDNS

1. Зареєструйте піддомен на https://www.duckdns.org
2. Дізнайтесь свою публічну IP (whatismyip.com) і пропишіть її в DuckDNS, або запустіть оновлювач IP.
3. На роутері пробросьте порти **80** і **443** на цей комп'ютер (LAN IP).
4. Перевірте, що `nslookup YOUR-SUBDOMAIN.duckdns.org` повертає вашу публічну IP.

> На VPS пункт 3 не потрібен — переконайтесь що порти 80/443 відкриті у фаєрволі провайдера / `ufw`.

---

## 2. Установка Caddy

### Windows

Варіант 1 — Chocolatey:
```powershell
choco install caddy
```

Варіант 2 — Scoop:
```powershell
scoop install caddy
```

Варіант 3 — вручну: завантажте `caddy.exe` з https://caddyserver.com/download і покладіть у `C:\Users\PC\Downloads\b\` або додайте в PATH.

### Linux

**Debian / Ubuntu** (офіційний APT-репозиторій):
```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy
```

**Fedora / RHEL / Rocky:**
```bash
sudo dnf install 'dnf-command(copr)'
sudo dnf copr enable @caddy/caddy
sudo dnf install caddy
```

**Arch:**
```bash
sudo pacman -S caddy
```

**Інші дистрибутиви** — статичний бінарник:
```bash
curl -L -o caddy.tar.gz "https://caddyserver.com/api/download?os=linux&arch=amd64"
tar xzf caddy.tar.gz caddy
sudo mv caddy /usr/local/bin/
sudo chmod +x /usr/local/bin/caddy
```

Дозвольте Caddy слухати привілейовані порти 80/443 без `sudo`:
```bash
sudo setcap cap_net_bind_service=+ep $(which caddy)
```

> Якщо APT-пакет вже створив сервіс `caddy.service` — вимкніть його, бо ми запускаємо у терміналі:
> ```bash
> sudo systemctl disable --now caddy
> ```

Відкрийте порти у `ufw` (якщо увімкнено):
```bash
sudo ufw allow 80,443/tcp
```

---

## 3. Налаштування Caddyfile

Відредагуйте [Caddyfile](Caddyfile) і замініть `YOUR-SUBDOMAIN.duckdns.org` на ваш реальний домен.

---

## 4. Запуск

Потрібно два термінали — один під Colyseus, другий під Caddy.

### Windows (PowerShell)

**Термінал 1 — Colyseus:**
```powershell
cd server
npm start
```

**Термінал 2 — Caddy (з кореня проєкту):**
```powershell
caddy run --config Caddyfile
```

### Linux (bash)

**Термінал 1 — Colyseus:**
```bash
cd server
npm start
```

**Термінал 2 — Caddy (з кореня проєкту):**
```bash
caddy run --config Caddyfile
```

Сервер слухає на `127.0.0.1:2567`. Caddy сам:
- отримає сертифікат Let's Encrypt через HTTP-01 challenge,
- перенаправить HTTP → HTTPS,
- буде проксювати HTTPS на Colyseus,
- автоматично оброблятиме WebSocket upgrade (`wss://`).

---

## 5. Підключення з клієнта

```ts
import { Client } from "colyseus.js";
const client = new Client("wss://YOUR-SUBDOMAIN.duckdns.org");
```

Playground: `https://YOUR-SUBDOMAIN.duckdns.org/`
Monitor:    `https://YOUR-SUBDOMAIN.duckdns.org/monitor`

---

## Приклади Caddyfile для різних випадків

### A. Мінімальний (Caddy сам розбереться)

WebSocket, HTTPS, редірект HTTP→HTTPS — все ввімкнено за замовчуванням.

```caddy
game.duckdns.org {
    reverse_proxy 127.0.0.1:2567
}
```

### B. Локальна розробка без HTTPS

Caddy слухатиме на http://localhost, без сертифіката.

```caddy
http://localhost {
    reverse_proxy 127.0.0.1:2567
}
```

### C. Самопідписаний сертифікат для локальної мережі

Доступ з телефону у тій же Wi-Fi за IP — Caddy згенерує локальний CA.

```caddy
{
    local_certs
}

192.168.1.50 {
    reverse_proxy 127.0.0.1:2567
}
```

### D. Декілька кімнат на одному домені (path-based)

Гра + сайт + API на тому ж домені.

```caddy
game.duckdns.org {
    handle_path /game/* {
        reverse_proxy 127.0.0.1:2567
    }
    handle_path /api/* {
        reverse_proxy 127.0.0.1:3000
    }
    handle {
        root * /var/www/site
        file_server
    }
}
```

Клієнт підключається: `new Client("wss://game.duckdns.org/game")`.

### E. Декілька Colyseus-серверів через subdomain

```caddy
ru.game.duckdns.org {
    reverse_proxy 127.0.0.1:2567
}

eu.game.duckdns.org {
    reverse_proxy 127.0.0.1:2568
}
```

### F. Балансування навантаження між кількома Colyseus-процесами

⚠ Sticky sessions обов'язкові — Colyseus тримає WebSocket-з'єднання з конкретним інстансом.

```caddy
game.duckdns.org {
    reverse_proxy 127.0.0.1:2567 127.0.0.1:2568 127.0.0.1:2569 {
        lb_policy ip_hash
        health_uri /
        health_interval 10s
    }
}
```

### G. DNS-challenge (порт 80 закритий, або wildcard-сертифікат)

DuckDNS не підтримує офіційний DNS-плагін, але має `DuckDNS plugin` через xcaddy. Зазвичай простіше використати HTTP-challenge. Приклад для Cloudflare DNS:

```caddy
{
    acme_dns cloudflare YOUR_API_TOKEN
}

*.game.example.com {
    reverse_proxy 127.0.0.1:2567
}
```

Для DuckDNS потрібен власний білд Caddy:
```bash
xcaddy build --with github.com/caddy-dns/duckdns
```
```caddy
{
    acme_dns duckdns YOUR_DUCKDNS_TOKEN
}

game.duckdns.org {
    reverse_proxy 127.0.0.1:2567
}
```

### H. З базовою авторизацією на /monitor

Захист Colyseus monitor через HTTP Basic Auth (на стороні Caddy).

```caddy
game.duckdns.org {
    handle /monitor* {
        basicauth {
            admin $2a$14$HASHED_PASSWORD_HERE
        }
        reverse_proxy 127.0.0.1:2567
    }
    handle {
        reverse_proxy 127.0.0.1:2567
    }
}
```

Згенерувати хеш пароля:
```bash
caddy hash-password
```

### I. Rate limiting (захист від спаму конектами)

Потрібен `caddy-ratelimit` модуль (xcaddy build).

```caddy
{
    order rate_limit before reverse_proxy
}

game.duckdns.org {
    rate_limit {
        zone dynamic {
            key {remote_host}
            events 30
            window 1m
        }
    }
    reverse_proxy 127.0.0.1:2567
}
```

### J. CORS для крос-доменного клієнта

Якщо HTML-клієнт хоститься на іншому домені.

```caddy
game.duckdns.org {
    @cors_preflight method OPTIONS
    handle @cors_preflight {
        header Access-Control-Allow-Origin "https://myclient.example.com"
        header Access-Control-Allow-Methods "GET, POST, OPTIONS"
        header Access-Control-Allow-Headers "Content-Type, Authorization"
        respond "" 204
    }

    header Access-Control-Allow-Origin "https://myclient.example.com"
    reverse_proxy 127.0.0.1:2567
}
```

### K. Розгорнутий продакшен-приклад

З логами у файл, gzip, безпековими хедерами та підняттям ліміту на розмір повідомлення.

```caddy
{
    email you@example.com
}

game.duckdns.org {
    encode zstd gzip

    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "strict-origin-when-cross-origin"
        -Server
    }

    reverse_proxy 127.0.0.1:2567 {
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto {scheme}
        transport http {
            read_buffer 64KB
            write_buffer 64KB
        }
    }

    log {
        output file /var/log/caddy/game.log {
            roll_size 10MB
            roll_keep 5
        }
        format json
    }
}
```

---

## Поширені проблеми

### Загальні

- **Сертифікат не видається** — порт 80 не доступний ззовні. Перевірте проброс портів та фаєрвол.
- **Порт 443 зайнятий** — щось вже слухає його. Зупиніть інший вебсервер.
- **WebSocket рветься через ~60 сек** — це нормально, клієнт Colyseus сам перепідключиться. Якщо потрібен довший keep-alive, додайте `transport http { dial_timeout 30s read_timeout 0 }` у `reverse_proxy`.

### Windows

- **Брандмауер Windows** запитає дозвіл при першому запуску Caddy — натисніть "Allow".
- **Порт 443 зайнятий**: `Get-Process -Id (Get-NetTCPConnection -LocalPort 443).OwningProcess`. Часто винні IIS / Skype.
- **Caddy не може писати в каталог сертифікатів** — запустіть PowerShell від адміністратора (один раз, щоб ініціалізувати `%AppData%\Caddy`).

### Linux

- **`bind: permission denied`** на портах 80/443 — застосуйте `setcap` (див. розділ установки) або запустіть з `sudo`.
- **`bind: address already in use`** — `sudo ss -tlnp | grep -E ':80|:443'`. Зазвичай це nginx/apache; зупиніть: `sudo systemctl stop nginx`.
- **Сервіс `caddy.service` конфліктує з ручним запуском** — `sudo systemctl disable --now caddy`.
- **Сертифікати у незвичному місці** — Caddy зберігає їх у `~/.local/share/caddy/` (або `/var/lib/caddy/` коли запущено як systemd-сервіс).
