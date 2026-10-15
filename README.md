# agent-browser

A real, headful Chromium for coding agents, one persistent profile per project, on a
desktop a human can open in a browser to sign in, solve captchas, or pass 2FA and
passkey prompts. Agents drive it over CDP through the `chrome-devtools` MCP server. Built
for a single-operator homelab: it runs as two containers, published only on 127.0.0.1.

## How it fits together

```
agent (pi, Claude Code, Codex, opencode)
  stdio MCP: agent-browser mcp           host launcher (bin/agent-browser, Node 22+, no deps)
    - resolves the project from the working directory
    - derives the project token from a shared secret
    - runs chrome-devtools-mcp against ws://127.0.0.1:<port>/t/<token>/devtools/browser
    - adds browser_handoff, browser_downloads, browser_info
        |
        v
agent-browser-gateway                    sidecar sharing the browser container's network
    - the only published port, 127.0.0.1 on the host
    - token -> project; proxies /json/* and /devtools/* to that project's Chromium only
    - starts browsers on demand, stops them after IDLE_MINUTES without CDP traffic
        |  run/want/<project>  (gateway -> supervisor)
        |  run/up/<project>    (supervisor -> gateway)
        v
agent-browser                            stock lscr.io/linuxserver/chromium (Selkies view on :3000)
    - browser/supervisor.sh, from labwc's autostart: one Chromium per project with
      --user-data-dir=/data/projects/<p>/profile, debug port on 127.0.0.1 inside the
      container, window titled [<p>], downloads to /data/projects/<p>/downloads
    - browser/policies: no sync or sign-in, no password manager, no download prompt
```

### Projects

The project is the directory name of the main checkout, so every worktree of a repository
shares one browser. A submodule is its own project. Outside a git repository the project is
`scratch`, which is wiped whenever it stops. `AGENT_BROWSER_PROJECT` or `--project`
overrides it.

### Data

```
data/
  desktop/                    the container's /config (Selkies and labwc state; no browser profile)
  projects/<p>/profile/       Chromium user data: cookies and logins
  projects/<p>/downloads/     where downloads land (readable on the host)
  run/want, run/up            gateway/supervisor handshake
  run/supervisor.log
```

## Security model

- **Network:** the gateway is published on host 127.0.0.1 only. Each Chromium's debug port
  listens on 127.0.0.1 inside the container's network namespace, so nothing else on the
  Docker network reaches it except through the gateway. The human view (port 3000) is meant
  to sit behind a reverse proxy with its own authentication (WireGuard + Authelia in the
  homelab).
- **Tokens:** a token is `<project>.<HMAC-SHA256(secret, project)>`. The gateway serves a
  token only its own project's browser and never lists other projects. This stops one
  project's agent, or a page prompt-injecting it, from reaching another project's signed-in
  sessions through the MCP tools or CDP.
- **Limits:** every agent runs as the same Unix user. The secret, every profile directory
  and the Docker socket are all readable to that user, and Chromium's `basic` password
  store gives no real encryption at rest. The tokens prevent accidents and cross-project
  injection, not a deliberately hostile local process.
- **Profiles are not backed up** by design. They hold live session cookies, and signing in
  again is cheap. A copy of a profile in a backup would be a copy of every login in it.

## Launcher

```
agent-browser mcp | status | start | stop | focus | hold [min] | downloads | ws | http | project
```

Configuration: `AGENT_BROWSER_URL` (default `http://127.0.0.1:5858`), the secret in
`AGENT_BROWSER_SECRET` or `~/.config/agent-browser/secret`. MCP client configuration, for
any harness:

```json
{ "command": "agent-browser", "args": ["mcp"] }
```

The pinned `chrome-devtools-mcp` version is `CHROME_DEVTOOLS_MCP` in `cli/mcp-proxy.js`.

## Gateway configuration

| Variable | Default | |
|---|---|---|
| `AGENT_BROWSER_SECRET` | required | at least 32 characters, same value as the launcher's |
| `PORT` | `5858` | listen port, inside the shared network namespace |
| `IDLE_MINUTES` | `60` | stop a browser after this long without CDP traffic (`0`: never) |
| `HOST_DATA_DIR` | `/data` | host path of `/data`, reported to agents so they can read downloads |
| `VIEW_URL` | | the human view URL given to agents |
| `DEBUG_PORT_START`, `DEBUG_PORT_END` | `9300`, `9399` | Chromium debug ports inside the container |
| `READY_TIMEOUT_SECONDS` | `45` | how long `ensure` waits for a browser to answer |

## Deploying

See the homelab stack (`agent-browser/docker-compose.yaml` there) for the reference
deployment: the browser container mounts `browser/` at `/agent-browser`, `browser/autostart`
and `browser/menu.xml` into `/config/.config/labwc/`, and `browser/policies` at
`/etc/chromium/policies/managed`. The gateway image is published as
`ghcr.io/justmytwospence/agent-browser-gateway` by pushing a `vX.Y.Z` tag.

## Development

```
npm test        # gateway, launcher and MCP proxy unit tests (node:test, no dependencies)
```

The skill for agents is in `skill/agent-browser/SKILL.md`. It is installed globally from
the dotfiles, which keep a copy.
