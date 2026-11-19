import { timingSafeEqual } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import uiText from "./ui.html" with { type: "text" };
import {
  type Manifest,
  type Verdict,
  IMAGE_TYPES,
  imagePaths,
  imageType,
  isExperimentName,
  isSafeRelPath,
  validateAnswers,
  validateManifest,
} from "./manifest.ts";

// Layout on disk: <data>/<experiment>/manifest.json, files/<path>, verdicts.jsonl (append-only, last line per item wins).

// With type "text" Bun yields the file as a string, but its typings declare every .html import as an HTMLBundle.
const page = uiText as unknown as string;

export type ServerOptions = { dataDir: string; token: string; host: string; port: number };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sameSecret(given: string | null | undefined, token: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

// The bearer form is for the CLI; the custom header is what the auth proxy in front injects for browsers.
function authorized(req: Request, token: string): boolean {
  const auth = req.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
  return sameSecret(bearer, token) || sameSecret(req.headers.get("x-image-review-token"), token);
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    (s) => s.isFile(),
    () => false,
  );
}

// A cross-site form can only POST text/plain, urlencoded or multipart; requiring JSON keeps it from posting verdicts through the proxy's session.
function isJson(req: Request): boolean {
  return (
    (req.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ===
    "application/json"
  );
}

async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${crypto.randomUUID()}`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

export function createHandler(dataDir: string, token: string) {
  const expDir = (name: string) => join(dataDir, name);

  async function loadManifest(name: string): Promise<Manifest | undefined> {
    try {
      return JSON.parse(await readFile(join(expDir(name), "manifest.json"), "utf8")) as Manifest;
    } catch (e) {
      // ENOTDIR: a stray file in the data directory, not an experiment.
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return undefined;
      throw e;
    }
  }

  async function loadVerdicts(name: string): Promise<Verdict[]> {
    try {
      const text = await readFile(join(expDir(name), "verdicts.jsonl"), "utf8");
      // A torn line (crash mid-append) stops reads of this experiment with its line number, so it can be fixed by hand.
      return text
        .split("\n")
        .map((l, n) => ({ l, n }))
        .filter(({ l }) => l !== "")
        .map(({ l, n }) => {
          try {
            return JSON.parse(l) as Verdict;
          } catch {
            throw new Error(`${name}/verdicts.jsonl line ${n + 1} is not valid JSON`);
          }
        });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
  }

  /** Latest verdict per item still in the manifest; verdicts for items a re-push removed stay in the file but are not current. */
  function latest(m: Manifest, vs: Verdict[]): Record<string, Verdict> {
    const ids = new Set(m.items.map((it) => it.id));
    const out: Record<string, Verdict> = {};
    for (const v of vs) if (ids.has(v.item)) out[v.item] = v;
    return out;
  }

  async function handle(req: Request): Promise<Response> {
    if (!authorized(req, token)) return json({ error: "unauthorized" }, 401);
    const url = new URL(req.url);
    let parts: string[];
    try {
      parts = url.pathname
        .split("/")
        .filter((s) => s !== "")
        .map(decodeURIComponent);
    } catch {
      return json({ error: "malformed path" }, 400);
    }

    if (url.pathname === "/" && req.method === "GET")
      return new Response(page, { headers: { "Content-Type": "text/html; charset=utf-8" } });

    if (parts[0] === "files" && req.method === "GET") {
      const [, name, ...rest] = parts;
      const rel = rest.join("/");
      const type = imageType(rel);
      if (!name || !isExperimentName(name) || !isSafeRelPath(rel) || !type)
        return json({ error: "not found" }, 404);
      const f = join(expDir(name), "files", rel);
      if (!(await exists(f))) return json({ error: "not found" }, 404);
      return new Response(Bun.file(f), {
        headers: {
          "Content-Type": type,
          "X-Content-Type-Options": "nosniff",
          // Re-pushing can replace an image at the same path, so revalidate every time.
          "Cache-Control": "private, no-cache",
        },
      });
    }

    if (parts[0] !== "api" || parts[1] !== "experiments") return json({ error: "not found" }, 404);
    const name = parts[2];

    if (name === undefined && req.method === "GET") {
      await mkdir(dataDir, { recursive: true });
      const out = [];
      for (const d of (await readdir(dataDir)).sort()) {
        if (!isExperimentName(d)) continue;
        // One broken experiment is reported in its row instead of failing the whole list.
        try {
          const m = await loadManifest(d);
          if (!m) continue;
          out.push({
            name: d,
            title: m.title,
            items: m.items.length,
            judged: Object.keys(latest(m, await loadVerdicts(d))).length,
          });
        } catch (e) {
          out.push({ name: d, error: (e as Error).message });
        }
      }
      return json(out);
    }
    if (name === undefined || !isExperimentName(name))
      return json({ error: "invalid experiment name" }, 400);
    const sub = parts[3];

    if (sub === undefined && req.method === "GET") {
      const m = await loadManifest(name);
      if (!m) return json({ error: "no such experiment" }, 404);
      return json({ name, manifest: m, latest: latest(m, await loadVerdicts(name)) });
    }

    if (sub === "files" && req.method === "PUT") {
      const rel = parts.slice(4).join("/");
      if (!isSafeRelPath(rel) || !imageType(rel))
        return json(
          { error: `path must be relative and end in ${Object.keys(IMAGE_TYPES).join("/")}` },
          400,
        );
      await writeAtomic(join(expDir(name), "files", rel), new Uint8Array(await req.arrayBuffer()));
      return json({ ok: true });
    }

    if (sub === "manifest" && req.method === "PUT") {
      if (!isJson(req)) return json({ error: "Content-Type must be application/json" }, 415);
      let m: unknown;
      try {
        m = await req.json();
      } catch {
        return json({ error: "body is not JSON" }, 400);
      }
      const errs = validateManifest(m);
      if (errs.length) return json({ error: "invalid manifest", details: errs }, 400);
      const missing = [];
      for (const p of imagePaths(m as Manifest)) {
        if (!(await exists(join(expDir(name), "files", p)))) missing.push(p);
      }
      if (missing.length) return json({ error: "images not uploaded", details: missing }, 400);
      await writeAtomic(join(expDir(name), "manifest.json"), JSON.stringify(m, null, 2));
      return json({ ok: true });
    }

    if (sub === "verdicts" && req.method === "GET") {
      if (!(await loadManifest(name))) return json({ error: "no such experiment" }, 404);
      return json(await loadVerdicts(name));
    }

    if (sub === "verdicts" && req.method === "POST") {
      const m = await loadManifest(name);
      if (!m) return json({ error: "no such experiment" }, 404);
      if (!isJson(req)) return json({ error: "Content-Type must be application/json" }, 415);
      let body: { item?: unknown; answers?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return json({ error: "body is not JSON" }, 400);
      }
      if (typeof body.item !== "string" || !m.items.some((it) => it.id === body.item))
        return json({ error: "unknown item" }, 400);
      const errs = validateAnswers(m, body.answers);
      if (errs.length) return json({ error: "invalid answers", details: errs }, 400);
      const v: Verdict = {
        item: body.item,
        answers: body.answers as Verdict["answers"],
        // Informational only: set by the auth proxy in front; the token is what authorizes.
        by: req.headers.get("x-forwarded-email") ?? "api",
        at: new Date().toISOString(),
      };
      // After a torn last line, start on a fresh line so the new verdict is not glued onto it.
      const vf = join(expDir(name), "verdicts.jsonl");
      const size = (await stat(vf).catch(() => undefined))?.size ?? 0;
      const fresh =
        size === 0 ||
        (await Bun.file(vf)
          .slice(size - 1)
          .text()) === "\n";
      await appendFile(vf, (fresh ? "" : "\n") + JSON.stringify(v) + "\n");
      return json(v);
    }

    return json({ error: "not found" }, 404);
  }

  return async (req: Request): Promise<Response> => {
    try {
      return await handle(req);
    } catch (e) {
      console.error(e);
      return json({ error: (e as Error).message }, 500);
    }
  };
}

export function serve(o: ServerOptions) {
  return Bun.serve({
    hostname: o.host,
    port: o.port,
    fetch: createHandler(o.dataDir, o.token),
    maxRequestBodySize: 64 * 1024 * 1024,
  });
}
