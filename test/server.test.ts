import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Manifest } from "../src/manifest.ts";
import { createHandler } from "../src/server.ts";

const TOKEN = "t0ken-for-tests";
let dir: string;
let handle: (r: Request) => Promise<Response>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "image-review-test-"));
  handle = createHandler(dir, TOKEN);
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const req = (method: string, path: string, body?: BodyInit, headers: Record<string, string> = {}) =>
  handle(
    new Request(`http://local${path}`, {
      method,
      body,
      headers: { Authorization: `Bearer ${TOKEN}`, ...headers },
    }),
  );

const manifest: Manifest = {
  title: "demo",
  rows: [
    { key: "a", label: "Model A" },
    { key: "b", label: "Model B" },
  ],
  cols: [
    { key: "s1", label: "seed 1" },
    { key: "s2", label: "seed 2" },
  ],
  questions: [
    { key: "closest", label: "Closest row", type: "choice", options: "rows" },
    { key: "usable", label: "Usable", type: "number", min: 0, max: 4 },
    { key: "note", label: "Note", type: "text" },
  ],
  items: [
    {
      id: "x1",
      ref: "x1/ref.png",
      cells: { a: { s1: "x1/a1.png", s2: "x1/a2.png" }, b: { s1: "x1/b1.png" } },
    },
    { id: "x2", cells: { a: { s1: "x2/a1.png" } } },
  ],
};
const files = ["x1/ref.png", "x1/a1.png", "x1/a2.png", "x1/b1.png", "x2/a1.png"];

async function pushAll() {
  for (const f of files)
    expect((await req("PUT", `/api/experiments/e1/files/${f}`, `img:${f}`)).status).toBe(200);
  expect((await req("PUT", "/api/experiments/e1/manifest", JSON.stringify(manifest))).status).toBe(
    200,
  );
}

describe("auth", () => {
  test("rejects requests without the token, including the page and images", async () => {
    await pushAll();
    for (const p of ["/", "/api/experiments", "/files/e1/x1/ref.png"]) {
      expect((await handle(new Request(`http://local${p}`))).status).toBe(401);
      expect(
        (
          await handle(
            new Request(`http://local${p}`, {
              headers: { Authorization: "Bearer wrong-token-xxx" },
            }),
          )
        ).status,
      ).toBe(401);
    }
  });

  test("accepts the token as a bearer or as the proxy-injected header", async () => {
    expect((await req("GET", "/api/experiments")).status).toBe(200);
    const viaProxy = await handle(
      new Request("http://local/", { headers: { "X-Image-Review-Token": TOKEN } }),
    );
    expect(viaProxy.status).toBe(200);
    expect(await viaProxy.text()).toContain("<title>image-review</title>");
  });
});

describe("upload", () => {
  test("refuses a manifest until every image it names is uploaded", async () => {
    await req("PUT", "/api/experiments/e1/files/x1/ref.png", "img");
    const res = await req("PUT", "/api/experiments/e1/manifest", JSON.stringify(manifest));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; details: string[] };
    expect(body.error).toBe("images not uploaded");
    expect(body.details).toEqual(["x1/a1.png", "x1/a2.png", "x1/b1.png", "x2/a1.png"]);
  });

  test("refuses an invalid manifest with the reasons", async () => {
    const bad = { ...manifest, items: [{ id: "x1", cells: { zz: { s1: "x1/a1.png" } } }] };
    const res = await req("PUT", "/api/experiments/e1/manifest", JSON.stringify(bad));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { details: string[] }).details).toEqual([
      'items[0].cells: unknown row "zz"',
    ]);
  });

  test("refuses file paths that leave the experiment or are not images", async () => {
    // %2F hides the separators from the URL parser, so the path check itself has to reject these.
    for (const p of [
      "..%2Fescape.png",
      "a%2F..%2F..%2Fescape.png",
      "x1/page.html",
      "x1/vector.svg",
    ]) {
      expect((await req("PUT", `/api/experiments/e1/files/${p}`, "x")).status).toBe(400);
    }
    expect((await req("PUT", "/api/experiments/bad%2Fname/files/a.png", "x")).status).toBe(400);
  });

  test("lists the experiment and serves its images with an image content type", async () => {
    await pushAll();
    expect(await (await req("GET", "/api/experiments")).json()).toEqual([
      { name: "e1", title: "demo", items: 2, judged: 0 },
    ]);
    const img = await req("GET", "/files/e1/x1/b1.png");
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(img.headers.get("x-content-type-options")).toBe("nosniff");
    expect(img.headers.get("cache-control")).toBe("private, no-cache");
    expect(await img.text()).toBe("img:x1/b1.png");
    expect((await req("GET", "/files/e1/..%2Fmanifest.json")).status).toBe(404);
    expect((await req("GET", "/files/e1/x1/missing.png")).status).toBe(404);
  });

  test("does not serve another experiment's image through an encoded ../", async () => {
    await pushAll();
    expect((await req("PUT", "/api/experiments/e2/files/secret.png", "other")).status).toBe(200);
    expect((await req("GET", "/files/e1/..%2F..%2Fe2%2Ffiles%2Fsecret.png")).status).toBe(404);
  });

  test("leaves directories that are not valid experiment names out of the list", async () => {
    await pushAll();
    await mkdir(join(dir, "bad name"), { recursive: true });
    await writeFile(join(dir, "bad name", "manifest.json"), JSON.stringify(manifest));
    expect(
      ((await (await req("GET", "/api/experiments")).json()) as { name: string }[]).map(
        (x) => x.name,
      ),
    ).toEqual(["e1"]);
  });
});

describe("resilience", () => {
  test("a broken experiment is reported in its row and does not hide the others", async () => {
    await pushAll();
    await mkdir(join(dir, "e0"), { recursive: true });
    await writeFile(join(dir, "e0", "manifest.json"), "{not json");
    await writeFile(join(dir, "stray.txt"), "a file, not an experiment");
    const list = (await (await req("GET", "/api/experiments")).json()) as {
      name: string;
      error?: string;
    }[];
    expect(list.map((x) => x.name)).toEqual(["e0", "e1"]);
    expect(list[0]?.error).toContain("JSON");
    expect(list[1]?.error).toBeUndefined();
  });

  test("a torn verdict line fails that experiment with the line number", async () => {
    await pushAll();
    await writeFile(
      join(dir, "e1", "verdicts.jsonl"),
      '{"item":"x1","answers":{},"by":"api","at":"t"}\n{"item":"x2","ans\n',
    );
    const res = await req("GET", "/api/experiments/e1");
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe(
      "e1/verdicts.jsonl line 2 is not valid JSON",
    );
  });

  test("a save after a torn last line starts on a fresh line", async () => {
    await pushAll();
    await writeFile(join(dir, "e1", "verdicts.jsonl"), '{"item":"x2","ans');
    const res = await req(
      "POST",
      "/api/experiments/e1/verdicts",
      JSON.stringify({ item: "x1", answers: { closest: "a" } }),
    );
    expect(res.status).toBe(200);
    const lines = (await readFile(join(dir, "e1", "verdicts.jsonl"), "utf8")).split("\n");
    expect(lines[0]).toBe('{"item":"x2","ans');
    expect(JSON.parse(lines[1] ?? "").item).toBe("x1");
  });

  test("a malformed percent-escape is a 400, not a crash", async () => {
    expect((await req("GET", "/files/e1/%ZZ.png")).status).toBe(400);
  });

  test("verdicts for items a re-push removed are kept but not current", async () => {
    await pushAll();
    const post = (item: string) =>
      req(
        "POST",
        "/api/experiments/e1/verdicts",
        JSON.stringify({ item, answers: { closest: "a" } }),
      );
    expect((await post("x1")).status).toBe(200);
    expect((await post("x2")).status).toBe(200);
    const only = { ...manifest, items: manifest.items.filter((it) => it.id === "x1") };
    expect((await req("PUT", "/api/experiments/e1/manifest", JSON.stringify(only))).status).toBe(
      200,
    );
    const d = (await (await req("GET", "/api/experiments/e1")).json()) as {
      latest: Record<string, unknown>;
    };
    expect(Object.keys(d.latest)).toEqual(["x1"]);
    expect(await (await req("GET", "/api/experiments")).json()).toEqual([
      { name: "e1", title: "demo", items: 1, judged: 1 },
    ]);
    expect(
      ((await (await req("GET", "/api/experiments/e1/verdicts")).json()) as unknown[]).length,
    ).toBe(2);
  });
});

describe("verdicts", () => {
  const post = (body: unknown, headers?: Record<string, string>) =>
    req("POST", "/api/experiments/e1/verdicts", JSON.stringify(body), headers);

  test("rejects answers that do not fit the experiment's questions", async () => {
    await pushAll();
    const cases: [unknown, string][] = [
      [{ item: "nope", answers: {} }, "unknown item"],
      [{ item: "x1", answers: { closest: "zz" } }, "closest: not one of the options"],
      [{ item: "x1", answers: { usable: 5 } }, "usable: must be an integer in 0..4"],
      [{ item: "x1", answers: { usable: 1.5 } }, "usable: must be an integer in 0..4"],
      [{ item: "x1", answers: { other: "a" } }, 'unknown question "other"'],
    ];
    for (const [body, msg] of cases) {
      const res = await post(body);
      expect(res.status).toBe(400);
      const e = (await res.json()) as { error: string; details?: string[] };
      expect([e.error, ...(e.details ?? [])]).toContain(msg);
    }
    expect(await (await req("GET", "/api/experiments/e1/verdicts")).json()).toEqual([]);
  });

  test("appends every save and reports the last one per item as latest", async () => {
    await pushAll();
    expect(
      (await post({ item: "x1", answers: { closest: "a", usable: 2, note: null } })).status,
    ).toBe(200);
    expect((await post({ item: "x2", answers: { closest: null } })).status).toBe(200);
    expect(
      (
        await post(
          { item: "x1", answers: { closest: "b", usable: 3, note: "hands" } },
          { "X-Forwarded-Email": "rev@example.com" },
        )
      ).status,
    ).toBe(200);

    const all = (await (await req("GET", "/api/experiments/e1/verdicts")).json()) as {
      item: string;
    }[];
    expect(all.map((v) => v.item)).toEqual(["x1", "x2", "x1"]);

    const d = (await (await req("GET", "/api/experiments/e1")).json()) as {
      latest: Record<string, { answers: unknown; by: string }>;
    };
    expect(d.latest.x1?.answers).toEqual({ closest: "b", usable: 3, note: "hands" });
    expect(d.latest.x1?.by).toBe("rev@example.com");
    expect(d.latest.x2?.by).toBe("api");

    const lines = (await readFile(join(dir, "e1", "verdicts.jsonl"), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(await (await req("GET", "/api/experiments")).json()).toEqual([
      { name: "e1", title: "demo", items: 2, judged: 2 },
    ]);
  });
});
