# image-review

A small web screen for judging generated images side by side, and an API/CLI so an agent can upload experiments and read the verdicts back.

Each experiment brings its own layout and questions in a `manifest.json`: what goes in the rows and columns (models x seeds, strengths x seeds, ...) and what the reviewer is asked (pick the closest row, count usable images, good/bad, free text). Nothing about one particular comparison is built in.

## Screen

- One page per item: the reference image on the left, the rows x columns grid on the right. Cells shrink so every row fits on one screen, down to 80px; beyond about eight rows the page scrolls. Per-row metrics from the manifest sit next to the row label
- Click a generated image to see it next to the reference at native size; both panes scroll and zoom together. Clicking the reference shows it alone
- Keys: `←` `→` items, `u` next item without a verdict, `1`-`9` the first choice question, `n` focus the text field, `Enter` save and go to the next item, `Esc` close the zoom. Every key action is also a button or a field you can click

## Install

Requires [Bun](https://bun.sh). The version is pinned in `.mise.toml`; with [mise](https://mise.jdx.dev), `mise install` gets it.

```bash
git clone https://github.com/TakashiAihara/image-review
cd image-review
bun install
bun run build   # single binary at dist/image-review
```

`bun run install-bin` links `src/cli.ts` into `~/.local/bin/image-review` instead.

## Run

Every request, including the page and the images, needs the token: as `Authorization: Bearer <token>` (the CLI) or as an `X-Image-Review-Token: <token>` header. The server refuses to start without one.

```bash
export IMAGE_REVIEW_TOKEN="$(head -c 24 /dev/urandom | base64)"
dist/image-review serve --data ./data --host 127.0.0.1 --port 8080
```

Browsers do not send that header on their own. Put an authenticating reverse proxy in front (for example oauth2-proxy with an OIDC provider) and have it inject `X-Image-Review-Token` after login. If the proxy also sets `X-Forwarded-Email`, it is recorded as the reviewer; the server takes that header as given, so the proxy must overwrite any value the client sent. Agents talk to the server directly with the bearer token and are recorded as `api` unless they set the header.

## Upload an experiment and read verdicts

```bash
export IMAGE_REVIEW_URL=http://127.0.0.1:8080
export IMAGE_REVIEW_TOKEN=...            # same token as the server
dist/image-review check examples/demo    # validate locally, upload nothing
dist/image-review push examples/demo --name demo
dist/image-review ls
dist/image-review verdicts demo          # latest verdict per item
dist/image-review verdicts demo --all    # every save, in order
```

`push` uploads every image the manifest names, then the manifest; the server rejects a manifest whose images are not all present. Each upload may be up to 64 MB. Pushing again under the same name replaces the manifest and keeps the verdicts file; verdicts for items the new manifest no longer has stay in the file but are no longer reported as current.

The CLI refuses to send the token over plain `http://` to anything but this machine. Use `https://`, or set `IMAGE_REVIEW_ALLOW_HTTP=1` when the network between the CLI and the server is trusted (the server itself does not terminate TLS).

Exit codes: 0 ok, 1 the operation failed (invalid manifest, missing images, server error), 2 configuration problem (`IMAGE_REVIEW_URL` / `IMAGE_REVIEW_TOKEN` not set, `IMAGE_REVIEW_URL` not a valid URL, or plain http to another host without `IMAGE_REVIEW_ALLOW_HTTP=1`).

## Manifest

See `examples/demo/manifest.json` for a complete one.

| Field                     | Meaning                                                       |
| ------------------------- | ------------------------------------------------------------- |
| `title`                   | Shown in the header and the experiment list                   |
| `guide`                   | Optional instructions shown above the grid                    |
| `refLabel`                | Optional caption of the reference image (default `reference`) |
| `rows`, `cols`            | Axes as `[{ "key", "label" }]`                                |
| `questions`               | What the reviewer answers, see below                          |
| `items[].id`              | Unique item id                                                |
| `items[].ref`             | Optional reference image path                                 |
| `items[].cells[row][col]` | Image path; a missing cell renders blank                      |
| `items[].metrics[row]`    | Optional `{ name: value }` shown next to the row label        |

Image paths are relative to the directory holding `manifest.json`, must stay inside it (the CLI also refuses symlinks that point outside), and end in `.jpg`, `.jpeg`, `.png`, `.webp`, `.gif` or `.avif`.

Every question needs a unique `key` and a `label`. Types:

| `type`   | Extra fields                                            | Answer                                                               |
| -------- | ------------------------------------------------------- | -------------------------------------------------------------------- |
| `choice` | `options`: `"rows"`, `"cols"` or `[{ "key", "label" }]` | one option key                                                       |
| `number` | `min`, `max` (integers)                                 | an integer in range (buttons up to 21 values, a number field beyond) |
| `text`   | none                                                    | up to 2000 characters                                                |

Any question may be left unanswered (`null`).

## Storage

```text
<data>/<experiment>/manifest.json
<data>/<experiment>/files/<image paths>
<data>/<experiment>/verdicts.jsonl   # one JSON line per save: { item, answers, by, at }; the last line per item is current
```

Verdicts are append-only, so earlier answers are never lost.

## API

All endpoints require the token. Request bodies sent to `POST .../verdicts` and `PUT .../manifest` must have `Content-Type: application/json` (a cross-site form can only POST text/plain, urlencoded or multipart, so it cannot use a logged-in reviewer's session to forge verdicts; the manifest PUT requires it for consistency).

| Method and path                           | Purpose                                                       |
| ----------------------------------------- | ------------------------------------------------------------- |
| `GET /api/experiments`                    | List: name, title, item count, judged count                   |
| `GET /api/experiments/:name`              | Manifest and the latest verdict per item                      |
| `GET /api/experiments/:name/verdicts`     | Every saved verdict                                           |
| `POST /api/experiments/:name/verdicts`    | Body `{ "item", "answers" }`, validated against the questions |
| `PUT /api/experiments/:name/files/<path>` | Upload one image (raw body)                                   |
| `PUT /api/experiments/:name/manifest`     | Upload the manifest (JSON body)                               |
| `GET /files/:name/<path>`                 | Serve an image                                                |

## Development

```bash
bun run check   # typecheck, lint, format check, tests
```

## License

MIT
