import { expect, test } from "bun:test";
import { isSafeRelPath, validateManifest } from "../src/manifest.ts";

const base = {
  title: "t",
  rows: [{ key: "a", label: "A" }],
  cols: [{ key: "c", label: "C" }],
  questions: [{ key: "q", label: "Q", type: "choice", options: [{ key: "y", label: "yes" }] }],
  items: [{ id: "i", ref: "r.png", cells: { a: { c: "i/a.png" } } }],
};

test("accepts a minimal valid manifest", () => {
  expect(validateManifest(base)).toEqual([]);
});

test("names each problem in an invalid manifest", () => {
  const m = {
    ...base,
    rows: [
      { key: "a", label: "A" },
      { key: "a", label: "again" },
    ],
    questions: [
      { key: "q", label: "Q", type: "number", min: 5, max: 1 },
      { key: "q2", label: "Q2", type: "slider" },
    ],
    items: [
      { id: "i", ref: "/etc/passwd", cells: { a: { zz: "ok.png" } } },
      { id: "i", cells: {} },
      { id: "j", cells: { a: { c: "page.html" } }, metrics: { zz: { sim: 1 }, a: { sim: [1] } } },
    ],
  };
  expect(validateManifest(m)).toEqual([
    'rows[1]: duplicate key "a"',
    "questions[0]: number needs integer min <= max",
    "questions[1]: type must be choice, number or text",
    "items[0].ref: unsafe path or not an image",
    'items[0].cells.a: unknown col "zz"',
    'items[1]: duplicate id "i"',
    "items[2].cells.a.c: unsafe path or not an image",
    'items[2].metrics: unknown row "zz"',
    "items[2].metrics.a: must map names to numbers or strings",
  ]);
});

test("safe paths stay inside the experiment directory", () => {
  for (const p of ["a.png", "x/y/z.webp", "seed-42_v1.jpg"]) expect(isSafeRelPath(p)).toBe(true);
  for (const p of [
    "",
    "/abs.png",
    "../up.png",
    "a/../b.png",
    "a//b.png",
    "./a.png",
    "a\\b.png",
    "a\0.png",
  ])
    expect(isSafeRelPath(p)).toBe(false);
});
