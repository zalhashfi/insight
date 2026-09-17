# INSIGHT

**Your own IoT cloud, on your own Cloudflare account.** Point your hardware at one endpoint over HTTPS or WebSocket, watch variables appear on their own, build realtime drag-and-drop dashboards, automate, and read it all back through a clean API. INSIGHT is single-tenant and self-hosted: it deploys into _your_ Cloudflare account on Workers, Durable Objects, D1, and R2.

## Features

- 📡 **Telemetry over HTTPS or WebSocket** — hardware POSTs JSON to a project; variables auto-create on first sight. No schema to define, no MQTT broker to run.
- 📊 **Realtime dashboards** — a drag-and-drop widget grid streams updates over hibernating WebSockets; share any dashboard read-only by public link, or embed it in another site.
- 🧩 **Embeddable widgets** — every widget is a framework-agnostic Web Component you can lift straight into your own app.
- 🎮 **Two-way control** — toggles, sliders, color pickers, and buttons write values back to hardware via short polls or a control socket.
- 🤖 **Visual automations** — variable, schedule, sunrise/sunset, and event triggers run conditions and actions: webhooks, code snippets, and service integrations.
- 🔌 **Integrations** — fan out to HTTP, email, and chat (Slack, Telegram, Discord, and more).
- 📖 **Clean read API** — latest state, time-series, and variable listings behind one token.
- 📥 **CSV export** — pick a time range, the variables, and the device, and stream the history out as CSV (long or wide layout).
- 🧠 **Native MCP server** — an owner-gated Model Context Protocol endpoint with a Claude connector for AI clients (off by default).
- 👥 **Multi-user** — owner / admin / member roles, email invites, and social sign-in (Google, GitHub).
- 📝 **Audit log** — every privileged action recorded and paginated in the UI.
- 🔧 **Flash from the browser** — upload a compiled `.bin` from your computer and send it to any device over the air, or flash it over USB with Web Serial. An optional agent can compile sketches for you instead.

## Quick start

1. **Deploy** to your Cloudflare account — `bun run deploy:platform` from a clone, or use the one-click carrier in [deploy/](deploy/).
2. **Create the owner account** — the first visit prompts a "Create owner account" page; the first signup becomes `owner`.
3. **Create a project** and mint a project token from the dashboard.
4. **Send telemetry** — variables are created the moment data arrives:

   ```bash
   curl -X POST https://<your-worker>/v1/telemetry \
     -H "Authorization: Bearer $INSIGHT_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"metrics":{"temperature":23.4,"humidity":61}}'
   ```

5. **Read it back:**

   ```bash
   curl https://<your-worker>/v1/projects/<project>/state \
     -H "Authorization: Bearer $INSIGHT_TOKEN"
   ```

## Flashing hardware

Everything a board needs can happen in the browser, without installing a compiler:

1. Compile the sketch wherever you like and upload the resulting `.bin` from **Devices → Upload firmware**.
2. Give it a version. That version is now a firmware release you can assign to any device and send over the air.
3. To flash it over USB instead, use the **Flash** button next to the uploaded image — it writes through Web Serial at the right offset for the chip you pick.

Flashing needs Chrome, Edge or Opera on desktop, or Chrome on Android — Safari and Firefox have no Web Serial.

**Optional: compile in the browser.** Compiling a sketch is the one part a browser cannot do — the ESP32 sysroot alone is over 150 MB — so INSIGHT can hand it to a small agent that runs `arduino-cli` on your own machine:

```bash
curl -fsSL -o insight-agent https://github.com/<your-agent-repo>/releases/latest/download/insight-agent-macos-arm64
chmod +x insight-agent
arduino-cli core install esp32:esp32

INSIGHT_INSTANCE=https://<your-worker> INSIGHT_TOKEN=<admin token> ./insight-agent
```

Point the Code page at your own agent repo from **Settings → Build agent repository**, and use the "Other platforms" link there for the other builds. The agent dials out to your instance, so there is no port to open and no certificate to install; it never touches the serial port, which the browser owns.

A saved build becomes a firmware version you can send to any device over the air.

## Architecture

- **Worker** ([worker/](worker/)) — a single Hono app. Durable Objects for Project, Dashboard, Scheduler, and the MCP agent; one Workflow for provisioning; D1 (metadata), R2 (telemetry history), KV (read cache + JWKS).
- **Web** ([web/](web/)) — Vue 3 + Tailwind + Reka UI admin panel and drag-and-drop dashboard builder, built and served as Worker static assets.
- **Shared** ([shared/](shared/)) — framework-agnostic Web Component widgets, the integration catalog, and automation blocks, consumed by both web and worker so there is a single source of truth.
- **Deploy** ([deploy/](deploy/)) — the small config carrier behind the one-click Deploy to Cloudflare.
- **Agent** — an optional CLI on your own machine that runs `arduino-cli` for browser builds. Separate repo, separate release, configurable from Settings.

```
worker/   Cloudflare Worker — API, Durable Objects, Workflow
web/      Vue 3 admin panel + dashboard builder
shared/   Web Component widgets, integration catalog, automation blocks
deploy/   One-click Deploy to Cloudflare config
scripts/  Build, version, and migration generators
```

## Storage

| Store | Holds |
|---|---|
| Project DO (SQLite) | Latest variable state, recent ring buffer, pending control writes, flush cursor |
| R2 | Cold telemetry history (NDJSON, partitioned by project + hour) |
| D1 | Users, sessions, accounts, projects, variables, dashboards, tokens, automations, integrations, audit log, OAuth provider config (metadata only — never any telemetry point) |
| KV | Cached `/state` responses and JWKS |
| Dashboard DO | Per-dashboard subscriptions + hibernated WebSockets |
| Scheduler DO | One alarm at the next schedule/sunset automation fire time |

## Authentication

[Better Auth](https://www.better-auth.com) handles sign-in. Email + password is on by default; Google and GitHub OAuth can be enabled at runtime from **Settings → Sign-in providers** (the owner enters a client ID + secret per provider, and the login page shows the matching buttons immediately).

The first signup on a fresh deployment becomes `owner`. After that, registration is closed: the owner invites people from **Users**, each with an owner / admin / member role. Sessions are cookie-based and persist 30 days; each device is a separate session, listed and revokable from **Users**.

## Development

INSIGHT uses [Bun](https://bun.sh).

```bash
bun install
bun run dev              # worker (wrangler dev)
bun run dev:web          # web (vite)
bun run typecheck
bun run build
bun run deploy:platform  # build + deploy the worker
bun test                 # worker + web test suites
```

## License

[MIT](LICENSE) © Arjun Krishna (upstream nodrix). Modifications for INSIGHT © zalhashfi.
