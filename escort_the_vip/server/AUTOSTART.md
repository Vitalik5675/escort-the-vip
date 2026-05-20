# Автозапуск сервера

---

## 🐧 Linux

### Варіант A — systemd (рекомендовано)

Systemd вбудований у будь-який сучасний Linux (Ubuntu, Debian, CentOS, Arch).
Переваги: автозапуск при старті, авто-рестарт при падінні, логи через `journalctl`.

#### Крок 1 — Збери сервер

```bash
cd /path/to/server
npm install
npm run build
```

#### Крок 2 — Дізнайся шляхи

```bash
which node        # наприклад: /usr/bin/node  або  /home/user/.nvm/versions/node/v22.x.x/bin/node
pwd               # поточна директорія — скопіюй, знадобиться нижче
```

#### Крок 3 — Створи service файл

```bash
sudo nano /etc/systemd/system/escort-server.service
```

Вміст файлу (замінити значення у кутових дужках):

```ini
[Unit]
Description=Escort Game Colyseus Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=<твій_linux_юзер>          # наприклад: ubuntu
WorkingDirectory=<шлях_до_server>  # наприклад: /home/ubuntu/escort/server
ExecStart=<шлях_до_node> dist/main.js  # наприклад: /usr/bin/node dist/main.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

#### Крок 4 — Активуй і запусти

```bash
sudo systemctl daemon-reload
sudo systemctl enable escort-server   # автозапуск при старті
sudo systemctl start escort-server    # запустити зараз
sudo systemctl status escort-server   # перевірити стан
```

#### Управління

```bash
sudo systemctl start escort-server    # запустити
sudo systemctl stop escort-server     # зупинити
sudo systemctl restart escort-server  # перезапустити
journalctl -u escort-server -f        # логи в реальному часі
journalctl -u escort-server -n 100    # останні 100 рядків логів
```

#### ⚠️ Порт 443 без root

Якщо сервер не запускається з помилкою `EACCES` на порту 443:

```bash
# Дати Node.js дозвіл прив'язуватись до портів < 1024 без sudo
sudo setcap 'cap_net_bind_service=+ep' $(which node)
```

Після цього рестарт сервісу не потрібен — перезапустить сам при наступному старті.

---

### Варіант B — PM2 (Linux)

```bash
npm install -g pm2

cd /path/to/server
npm run build
pm2 start dist/main.js --name "escort-server"
pm2 save

# Генерує і реєструє автозапуск для поточного init-системи (systemd/upstart/etc.)
pm2 startup
# Виконай команду яку виведе pm2 startup (вона починається з sudo)
```

#### Управління

```bash
pm2 status
pm2 logs escort-server
pm2 restart escort-server
pm2 stop escort-server
```

---

## 🪟 Windows

### Варіант A — PM2 (рекомендовано)

PM2 переваги: авто-рестарт при падінні, зручні логи, одна команда для автозапуску.

#### Встановлення (один раз)

```bash
npm install -g pm2
npm install -g pm2-windows-startup
```

#### Реєстрація сервера

```bash
cd C:\Users\PC\Downloads\claude_escort_game\server

npm run build

pm2 start dist/main.js --name "escort-server"
pm2 save
pm2-startup install
```

#### Управління

```bash
pm2 status                   # стан сервера
pm2 logs escort-server       # логи в реальному часі
pm2 restart escort-server    # перезапустити
pm2 stop escort-server       # зупинити
```

---

### Варіант B — Task Scheduler (без сторонніх інструментів)

#### Крок 1

Файл `start-server.bat` вже є в папці `server/` — він збирає і запускає сервер.

#### Крок 2 — Відкрий Task Scheduler

`Win + R` → `taskschd.msc` → Enter → правий клік на **Task Scheduler Library** → **Create Task**

#### Крок 3 — Налаштуй таску

**General:**
- Name: `Escort Game Server`
- ✅ Run whether user is logged on or not
- ✅ Run with highest privileges

**Triggers:**
- New → Begin the task: **At startup**
- Delay task for: **30 seconds** (чекає поки мережа підніметься)

**Actions:**
- New → Action: Start a program
- Program/script: `C:\Users\PC\Downloads\claude_escort_game\server\start-server.bat`
- Start in: `C:\Users\PC\Downloads\claude_escort_game\server`

**Settings:**
- ✅ If the task fails, restart every: 1 minute
- Attempt to restart up to: 3 times

#### Крок 4 — Перевір

Правий клік на таску → **Run** → перевір що сервер запустився.
