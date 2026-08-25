# ASPEN Build Board

Your dashboard, rebuilt so the browser reads a local cache instead of calling
Jenkins on every page load.

## What changed

**Before** — the browser called Jenkins directly through the proxy. Each
pipeline took two requests (fetch `lastBuild.number`, then fetch that build),
and paired Aspen pipelines took four. Across 28 pipelines that's roughly 90
requests on every page load, all of them blocking the render.

**After** — a background collector reads Jenkins on its own schedule and writes
to SQLite. The browser makes one request, `GET /api/status`, and gets everything.

```
                    every 60s                    on page load
  Jenkins ──────────► collector ──► SQLite ──► /api/status ──► browser
                                                   (~2ms)
```

Three specific speedups:

- **One request per job instead of two.** Asking for `lastBuild[...]` via the
  `tree` parameter returns the build inline, so the separate build fetch is gone.
- **Jenkins is off the critical path.** Page load never waits on it.
- **Bounded concurrency.** Six requests in flight rather than 90 at once, which
  is gentler on the Jenkins master than the old dashboard was.

## Security fix

The old `config.js` was loaded by the browser and contained both Jenkins API
tokens in plaintext. Anyone who opened the dashboard could read them from
DevTools.

**Rotate both tokens** at `<jenkins>/user/dhakalk/configure` → Add new Token,
then put the new ones in `.env`, which is gitignored and never served. The
browser now receives rendered status only — no URLs, no credentials.

Confirm `.gitignore` is committed before your first push, and check `git status`
to be sure `.env` isn't staged.

## Setup

```bash
npm install
cp .env.example .env      # add the rotated tokens
npm start
```

Open http://localhost:3001

### Self-signed certificate

Aspen Jenkins is on `https://172.20.54.219:8443` with a self-signed cert. Node
will reject it. Preferred fix:

```bash
NODE_EXTRA_CA_CERTS=/path/to/ca.pem npm start
```

As a temporary local fallback only, set `ALLOW_SELF_SIGNED=true` in `.env`.
That's scoped to this app's HTTP agent rather than disabling TLS
verification process-wide, but it's still not what you want on a shared host.

## Layout of the code

```
server/
  pipelines.js   Products, streams, and job URLs. Edit this to add a pipeline.
  config.js      Credentials and tuning, all from environment variables.
  jenkins.js     Jenkins client. Paired-job duration logic lives here.
  db.js          SQLite schema and queries.
  collector.js   Background polling loop.
  index.js       API + static file serving.
public/
  index.html     Markup.
  styles.css     Theme tokens and component styles.
  app.js         Rendering. One fetch, no Jenkins knowledge.
```

### Adding or changing a pipeline

Only `server/pipelines.js` needs editing:

```js
test05: `${ASPEN}/view/TEST05-Pipeline/job/TEST05-Pipeline`,          // single job
dev05:  [`${ASPEN}/.../DEV05-Multijob`, `${ASPEN}/.../Maintenance_Page_Off_DEV05`],
```

The array form replaces the old colon-separated string. That string was split
with a regex that had to work around the `://` in the URLs themselves — an
array removes the ambiguity entirely.

## How duration is measured

Single-job pipelines use the build's own duration.

Paired Aspen pipelines measure the gap between the Multijob's start and the
Maintenance_Page_Off job's start — the actual deployment window, which is what
your original dashboard computed. A pipeline counts as running if either job is
running, and as failed if either failed.

## Things worth knowing

**Running builds report `duration: 0`.** Jenkins only fills in `duration` on
completion, so elapsed time is computed from the start timestamp. The tile ticks
up once a second in the browser between polls — no extra requests.

**Progress bars use your own averages.** After three successful builds, the mean
of the last ten is used. Before that, the bar shows an indeterminate drift
rather than a fake percentage. Progress caps at 99% so an overrunning build
never reads as finished.

**Failed polls keep the last good data.** The collector never clears a row on
error; it records the message and the tile dims with the reason underneath. One
Jenkins going down doesn't blank the board.

**The sparkline is new.** Each tile shows the last twelve build durations,
coloured by result. That's only possible because history is now stored — the old
dashboard had no way to show whether a build was unusually slow.

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/status` | Layout, all pipeline state, server health, counts |
| `GET /api/history/:product/:env?limit=25` | Recent builds for one pipeline |
| `POST /api/refresh` | Force an immediate poll (the Refresh button) |
| `GET /healthz` | Liveness |

## Tuning

| Variable | Default | Notes |
|---|---|---|
| `POLL_INTERVAL_MS` | 60000 | Lower for snappier in-progress updates |
| `HEALTH_INTERVAL_MS` | 30000 | Server reachability checks |
| `CONCURRENCY` | 6 | Parallel Jenkins requests |
| `HISTORY_DEPTH` | 25 | Builds retained per pipeline |
| `STALE_AFTER_MS` | 180000 | When a tile dims as stale |

## Running it persistently

```bash
npm i -g pm2
pm2 start server/index.js --name build-board
pm2 save && pm2 startup
```

To split the collector onto its own process, remove the `collector.start()`
line from `server/index.js` and run `npm run collector` alongside.
