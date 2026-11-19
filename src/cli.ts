#!/usr/bin/env bun
import { readFile, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { Command } from "commander";
import {
  type Manifest,
  type Verdict,
  imagePaths,
  isExperimentName,
  validateManifest,
} from "./manifest.ts";
import { serve } from "./server.ts";

// Exit codes: 0 ok, 1 the operation failed (invalid manifest, server error), 2 missing configuration.

function env(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`${name} is not set`);
    process.exit(2);
  }
  return v;
}

function die(msg: string, details?: unknown): never {
  console.error(msg);
  if (Array.isArray(details)) for (const d of details) console.error(`  - ${d}`);
  process.exit(1);
}

/** Validates <dir>/manifest.json and that every image it names exists under <dir>. */
async function loadLocal(dir: string): Promise<Manifest> {
  let m: unknown;
  try {
    m = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
  } catch (e) {
    die(`cannot read ${join(dir, "manifest.json")}: ${(e as Error).message}`);
  }
  const errs = validateManifest(m);
  if (errs.length) die("invalid manifest", errs);
  const missing = [];
  const outside = [];
  // Resolve symlinks: the path text staying inside <dir> does not stop a link from pointing at ~/.ssh.
  const root = (await realpath(dir)) + sep;
  for (const p of imagePaths(m as Manifest)) {
    const real = await realpath(join(dir, p)).catch(() => undefined);
    if (real !== undefined && !real.startsWith(root)) {
      outside.push(`${p} -> ${real}`);
      continue;
    }
    const ok =
      real !== undefined &&
      (await stat(real).then(
        (s) => s.isFile(),
        () => false,
      ));
    if (!ok) missing.push(p);
  }
  if (missing.length) die("images named in the manifest are missing", missing);
  if (outside.length) die("images resolve outside the manifest directory (symlinks)", outside);
  return m as Manifest;
}

async function api(method: string, path: string, body?: BodyInit, type?: string): Promise<unknown> {
  const base = env("IMAGE_REVIEW_URL").replace(/\/+$/, "");
  // The bearer token would cross the network in cleartext; plain http is allowed only to this machine or when opted in.
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    console.error(`IMAGE_REVIEW_URL is not a valid URL: ${base}`);
    process.exit(2);
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol === "http:" && !loopback && process.env.IMAGE_REVIEW_ALLOW_HTTP !== "1") {
    console.error(
      `refusing to send the token over plain http to ${u.host}; use https, or set IMAGE_REVIEW_ALLOW_HTTP=1`,
    );
    process.exit(2);
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env("IMAGE_REVIEW_TOKEN")}`,
    Accept: "application/json",
  };
  if (type) headers["Content-Type"] = type;
  const res = await fetch(base + path, { method, body, headers, redirect: "manual" });
  const text = await res.text();
  let parsed: { error?: string; details?: unknown } | undefined;
  try {
    parsed = JSON.parse(text);
  } catch {
    die(
      `${method} ${path}: HTTP ${res.status}, response is not JSON (wrong URL, or an auth proxy answered?)`,
    );
  }
  if (!res.ok) die(`${method} ${path}: HTTP ${res.status} ${parsed?.error ?? ""}`, parsed?.details);
  return parsed;
}

const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");

const program = new Command()
  .name("image-review")
  .description(
    "Review generated images side by side; the layout and questions come from each experiment's manifest",
  );

program
  .command("serve")
  .description("Serve the review screen and API. IMAGE_REVIEW_TOKEN is required for every request")
  .requiredOption("--data <dir>", "directory holding experiments")
  .option("--host <host>", "address to bind", "127.0.0.1")
  .option("--port <port>", "port", "8080")
  .action((o: { data: string; host: string; port: string }) => {
    const s = serve({
      dataDir: o.data,
      token: env("IMAGE_REVIEW_TOKEN"),
      host: o.host,
      port: Number(o.port),
    });
    console.error(`listening on http://${s.hostname}:${s.port} (data: ${o.data})`);
  });

program
  .command("check <dir>")
  .description("Validate <dir>/manifest.json and the images it names, without uploading")
  .action(async (dir: string) => {
    const m = await loadLocal(dir);
    console.log(`ok: ${m.items.length} items, ${imagePaths(m).length} images`);
  });

program
  .command("push <dir>")
  .description(
    "Upload <dir>/manifest.json and its images as experiment <name> (IMAGE_REVIEW_URL, IMAGE_REVIEW_TOKEN)",
  )
  .requiredOption(
    "--name <name>",
    "experiment name: starts with a letter or digit, then [A-Za-z0-9._-], up to 64 chars",
  )
  .action(async (dir: string, o: { name: string }) => {
    if (!isExperimentName(o.name)) die(`invalid experiment name: ${o.name}`);
    const m = await loadLocal(dir);
    const paths = imagePaths(m);
    for (const [i, p] of paths.entries()) {
      await api("PUT", `/api/experiments/${o.name}/files/${enc(p)}`, Bun.file(join(dir, p)));
      if ((i + 1) % 50 === 0) console.error(`uploaded ${i + 1}/${paths.length}`);
    }
    // The manifest goes last: the server rejects it until every image it names is present.
    await api("PUT", `/api/experiments/${o.name}/manifest`, JSON.stringify(m), "application/json");
    console.log(`pushed ${o.name}: ${m.items.length} items, ${paths.length} images`);
  });

program
  .command("ls")
  .description("List experiments with how many items have a verdict")
  .action(async () => {
    console.log(JSON.stringify(await api("GET", "/api/experiments"), null, 2));
  });

program
  .command("verdicts <name>")
  .description(
    "Print the latest verdict per item as JSON; --all prints every saved record in order",
  )
  .option("--all", "every record, not just the latest per item")
  .action(async (name: string, o: { all?: boolean }) => {
    if (!isExperimentName(name)) die(`invalid experiment name: ${name}`);
    if (o.all) {
      console.log(JSON.stringify(await api("GET", `/api/experiments/${name}/verdicts`), null, 2));
      return;
    }
    const d = (await api("GET", `/api/experiments/${name}`)) as { latest: Record<string, Verdict> };
    console.log(JSON.stringify(d.latest, null, 2));
  });

await program.parseAsync();
