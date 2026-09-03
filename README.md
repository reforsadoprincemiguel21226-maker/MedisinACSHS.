# MedisinACSHS

MedisinACSHS is a static first-aid and health-information site with a local AI assistant. The assistant runs through [Ollama](https://ollama.com), so no cloud API key is required. Uploaded `.txt`, `.md`, and `.pdf` health documents are indexed locally and retrieved as context before the model answers.

The assistant is an information tool, not a doctor. It should not diagnose conditions or replace emergency services. Call `911` for an emergency and tell a trusted adult when appropriate.

## Quick Start

### 1. Install prerequisites

Install Node.js 24.x and Ollama:

- **macOS or Windows:** download and install Ollama from [ollama.com/download](https://ollama.com/download).
- **Linux:**

  ```bash
  curl -fsSL https://ollama.com/install.sh | sh
  ```

Confirm both tools are available:

```bash
node --version
ollama --version
```

### 2. Download the AI model

From the project folder, run:

```bash
ollama pull qwen3.5:0.8b
```

This downloads the small local model used by default. It is the easiest option for a laptop or Raspberry Pi. To use a larger model, download it and set `OLLAMA_MODEL` when starting the server:

```bash
ollama pull qwen3.5:4b
OLLAMA_MODEL=qwen3.5:4b ADMIN_TOKEN=replace-this-token npm start
```

See downloaded models with:

```bash
ollama list
```

If the default model is unavailable for your Ollama version, download any compatible chat model and set `OLLAMA_MODEL` to its exact name.

### 3. Install the project

```bash
git clone https://github.com/cGradying/MedisinACSHS.git
cd MedisinACSHS
npm install
```

### 4. Start Ollama

The Ollama desktop application normally starts the service automatically. If it is not already running, use a second terminal:

```bash
ollama serve
```

Leave that terminal open while developing. Do not run a second `ollama serve` if Ollama is already running.

### 5. Start MedisinACSHS

Set an admin token and start the web server:

```bash
ADMIN_TOKEN=replace-this-with-a-long-random-token npm start
```

For a quick local test only:

```bash
ADMIN_TOKEN=admin123 npm start
```

Keep this terminal open. The server prints the active app URL, model, and admin URL when it starts.

Open the app at <http://localhost:3000>.

## Admin Page and RAG Documents

The admin page manages the local health-information documents used by the assistant:

1. Start the server with `ADMIN_TOKEN` set.
2. Open <http://localhost:3000/admin.html>.
3. Enter the exact same token used to start the server.
4. Upload `.txt`, `.md`, or `.pdf` health-information files.
5. Confirm the document appears in the list.

For example, if the server was started with:

```bash
ADMIN_TOKEN=my-local-token npm start
```

enter `my-local-token` on the admin page. The token is kept only in the browser session and is sent as a bearer token to the server.

The built-in medkit reference is stored in `data/rag-defaults/` and is included automatically for every installation. Uploaded files are converted to text and stored under `data/rag-store/`. That directory is local machine data and is git-ignored; uploaded documents are not pushed to GitHub. Without `ADMIN_TOKEN`, all `/api/admin/*` routes are disabled.

Use focused, trustworthy documents such as school-approved first-aid guidance, public-health references, and emergency procedures. Include important warnings, timing, dosage limits, contraindications, and escalation instructions in the source documents. The assistant will refuse to invent an answer when no relevant document content is found.

## Configuration

The server supports these environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP server port |
| `OLLAMA_URL` | `http://localhost:11434/api/chat` | Ollama chat endpoint |
| `OLLAMA_MODEL` | `qwen3.5:0.8b` | Model name shown by `ollama list` |
| `OLLAMA_NUM_CTX` | `1024` | Ollama context window |
| `OLLAMA_TEMPERATURE` | `0.15` | Response creativity; lower values are more consistent |
| `ADMIN_TOKEN` | unset | Required token for admin routes |

Example with all commonly changed settings:

```bash
PORT=3000 \
OLLAMA_MODEL=qwen3.5:0.8b \
OLLAMA_NUM_CTX=1024 \
ADMIN_TOKEN=replace-this-token \
npm start
```

Do not commit real admin tokens or private health documents. For repeatable local use, export variables in your shell before `npm start` rather than putting secrets in the repository.

## Troubleshooting

**`ADMIN_TOKEN not set on the server`**

Start the server with the correctly spelled variable:

```bash
ADMIN_TOKEN=your-token npm start
```

**`EADDRINUSE: address already in use :::3000`**

Another process is using port 3000. Stop it, or choose another port:

```bash
PORT=3001 ADMIN_TOKEN=your-token npm start
```

Then open <http://localhost:3001>.

**Could not reach Ollama**

Make sure Ollama is running and the model is downloaded:

```bash
ollama list
ollama run qwen3.5:0.8b
```

Exit the interactive model session with `Ctrl-D`; the Ollama service can remain running in the background.

**The assistant says it does not have the information**

Open the admin page, confirm a relevant document is uploaded, and ask using words that appear in that document. The built-in medkit inventory is always available; additional documents are loaded from `data/rag-store/`. The RAG system intentionally does not answer from model memory when the uploaded data has no relevant match.

## Development

The project is a dependency-light Node.js static server:

```bash
npm install
ADMIN_TOKEN=dev-token npm start
```

The browser assistant is `A.i asistant.html`. Server chat and admin routes are in `server.js`; document extraction, chunking, indexing, and retrieval are in `data/rag.js`. The built-in RAG references live in `data/rag-defaults/`; the local RAG manifest and extracted uploads live in `data/rag-store/`.

There is no build step. After editing HTML, CSS, or JavaScript, refresh the browser. After editing `server.js` or `data/rag.js`, restart Node.

## Retuning the AI

The AI is intentionally split into safe routing, retrieval, and generation layers:

- **Routing:** edit `INTENT_TERMS` and `INTENT_EXPANSIONS` in `server.js` to recognize new ways users describe a topic. Keep crisis detection before RAG and model calls.
- **Default knowledge:** add reviewed `.md` or `.txt` references under `data/rag-defaults/`. These are included for every installation.
- **Private knowledge:** upload `.txt`, `.md`, or `.pdf` files through the admin page. They stay in the git-ignored `data/rag-store/` directory.
- **Answer style:** edit the `prompt` in `server.js`. Keep the rules that require retrieved facts, prohibit diagnosis and invention, and limit follow-up questions.
- **Creativity and length:** tune `OLLAMA_TEMPERATURE`, `OLLAMA_NUM_CTX`, and the Ollama `num_predict` option. Lower temperature is more consistent; change it gradually and test representative health, emotional, and crisis prompts.
- **Conversation wording:** edit the deterministic support functions in `server.js` when safety or emotional behavior must be reliable. Do not rely on a small model alone for crisis handling.

After retuning, run `node --check server.js`, restart Node, test a normal RAG question, an unsupported question, an emotional message, and crisis wording. Never use private patient data or real secrets in tests or commits.

## Calendar Import and Export

Open <http://localhost:3000/plan-schedule.html> to schedule an appointment. Booking creates a standard `.ics` calendar file, opens a Google Calendar event, and shares or downloads the ICS file depending on browser support. To import an existing event, choose an `.ics` file under **IMPORT AN ICS FILE**, review the populated fields, and book or export it again. The importer supports the appointment files generated by this app and reads `SUMMARY`, `DESCRIPTION`, `DTSTART`, and `DTEND`.

## Codebase Map

The repository keeps browser pages at the root because the static server and PWA use relative page links. The main ownership boundaries are:

| Path | Responsibility |
| --- | --- |
| `server.js` | Static server, Ollama chat route, intent routing, safety handling, and admin API |
| `A.i asistant.html` | Assistant UI, browser conversation state, Markdown rendering, and voice input controls |
| `plan-schedule.html` | Appointment form and ICS/Google Calendar import/export |
| `data/rag.js` | Document extraction, chunking, indexing, caching, and retrieval |
| `data/rag-defaults/` | Tracked default medkit and emotional-support references |
| `data/rag-store/` | Private uploaded RAG documents and manifest; git-ignored |
| `data/hospitals-data.js` | Deterministic hospital directory used by the assistant |
| `css/` | Page-specific stylesheets |
| `hotlines/` | Emergency hotline pages |
| `sw.js`, `assets/js/pwa-register.js`, `manifest.webmanifest` | PWA caching and installation |

Keep new shared browser data in `data/`, page styles in `css/`, and new static feature pages at the root unless the relative links and service-worker asset list are updated together.

## Raspberry Pi Kiosk Deployment

The following setup is intended for Raspberry Pi OS with a desktop environment.

### 1. Install Node.js, Chromium, and Ollama

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs chromium-browser curl
curl -fsSL https://ollama.com/install.sh | sh
ollama pull qwen3.5:0.8b
```

### 2. Clone and install

```bash
git clone https://github.com/cGradying/MedisinACSHS.git ~/MedisinACSHS
cd ~/MedisinACSHS
npm install
```

### 3. Create the systemd service

Create `/etc/systemd/system/medisinacshs.service`:

```ini
[Unit]
Description=MedisinACSHS server
After=network.target ollama.service
Wants=ollama.service

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/MedisinACSHS
ExecStart=/usr/bin/node server.js
Environment=ADMIN_TOKEN=replace-this-with-a-long-random-token
Environment=PORT=3000
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

Enable it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now medisinacshs.service
sudo systemctl status medisinacshs.service
```

### 4. Open the assistant automatically

Create `~/kiosk.sh`:

```bash
#!/bin/bash
until curl -sf http://localhost:3000/ -o /dev/null; do sleep 1; done
chromium-browser --kiosk --noerrdialogs --disable-infobars --incognito \
  "http://localhost:3000/A.i%20asistant.html"
```

Make it executable:

```bash
chmod +x ~/kiosk.sh
```

Enable desktop auto-login through `sudo raspi-config` under **System Options > Boot / Auto Login > Desktop Autologin**, then add the kiosk script to LXDE autostart:

```bash
mkdir -p ~/.config/lxsession/LXDE-pi
cat >> ~/.config/lxsession/LXDE-pi/autostart <<'EOF'
@xset s off
@xset -dpms
@xset s noblank
@/home/pi/kiosk.sh
EOF
```

After reboot, systemd starts the server and Chromium opens the assistant when the server responds. Access the admin page on the Pi at <http://localhost:3000/admin.html>.
