// The manifest is the contract between whoever produces an experiment (usually an AI agent)
// and the review screen. Layout (rows x cols) and the questions asked are data, not code,
// because each experiment compares different things and asks different questions.

export type Axis = { key: string; label: string };

export type Question =
  | { key: string; label: string; type: "choice"; options: Axis[] | "rows" | "cols" }
  | { key: string; label: string; type: "number"; min: number; max: number }
  | { key: string; label: string; type: "text" };

export type Item = {
  id: string;
  /** Path of the reference image, relative to the experiment directory. */
  ref?: string;
  /** cells[rowKey][colKey] = image path relative to the experiment directory. Missing cells render blank. */
  cells: Record<string, Record<string, string>>;
  /** Per-row machine metrics shown next to the row label, e.g. { wai: { dino: 0.41 } }. */
  metrics?: Record<string, Record<string, number | string>>;
};

export type Manifest = {
  title: string;
  guide?: string;
  refLabel?: string;
  rows: Axis[];
  cols: Axis[];
  questions: Question[];
  items: Item[];
};

export type Answers = Record<string, string | number | null>;

export type Verdict = { item: string; answers: Answers; by: string; at: string };

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isExperimentName(s: string): boolean {
  return NAME.test(s);
}

export const IMAGE_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
};

/** Content type for an image path, or undefined when the extension is not an allowed image. */
export function imageType(path: string): string | undefined {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const ext = name.slice(dot + 1).toLowerCase();
  return Object.hasOwn(IMAGE_TYPES, ext) ? IMAGE_TYPES[ext] : undefined;
}

export function isImagePath(p: unknown): p is string {
  return isSafeRelPath(p) && imageType(p) !== undefined;
}

/** Rejects absolute paths, `..` segments, backslashes and empty segments so a path can never leave the experiment directory. */
export function isSafeRelPath(p: unknown): p is string {
  if (typeof p !== "string" || p.length === 0 || p.length > 512) return false;
  if (p.startsWith("/") || p.includes("\\") || p.includes("\0")) return false;
  return p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

// Keys and ids become property names on plain objects (verdict maps, answers). Built-in names would
// collide: "__proto__" sets the prototype, and "toString" etc. read as present before anything is saved.
function isKey(v: unknown): v is string {
  return typeof v === "string" && v !== "" && !(v in Object.prototype);
}

function keyProblem(v: unknown): string {
  return typeof v === "string" && v !== ""
    ? `"${v}" is a built-in name`
    : "needs a non-empty string";
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function axes(v: unknown, where: string, errs: string[]): Axis[] {
  if (!Array.isArray(v) || v.length === 0) {
    errs.push(`${where}: must be a non-empty array`);
    return [];
  }
  const seen = new Set<string>();
  const ok: Axis[] = [];
  for (const [i, a] of v.entries()) {
    if (!isObj(a) || typeof a.label !== "string") {
      errs.push(`${where}[${i}]: needs string key and label`);
    } else if (!isKey(a.key)) {
      errs.push(`${where}[${i}].key: ${keyProblem(a.key)}`);
    } else if (seen.has(a.key)) {
      errs.push(`${where}[${i}]: duplicate key "${a.key}"`);
    } else {
      seen.add(a.key);
      ok.push(a as Axis);
    }
  }
  return ok;
}

/** Returns the list of problems; an empty list means `m` is a valid Manifest. */
export function validateManifest(m: unknown): string[] {
  const errs: string[] = [];
  if (!isObj(m)) return ["manifest must be a JSON object"];
  if (typeof m.title !== "string" || m.title === "") errs.push("title: required string");
  if (m.guide !== undefined && typeof m.guide !== "string") errs.push("guide: must be a string");
  if (m.refLabel !== undefined && typeof m.refLabel !== "string")
    errs.push("refLabel: must be a string");
  const rows = new Set(axes(m.rows, "rows", errs).map((a) => a.key));
  const cols = new Set(axes(m.cols, "cols", errs).map((a) => a.key));

  if (!Array.isArray(m.questions)) errs.push("questions: must be an array");
  else {
    const seen = new Set<string>();
    for (const [i, q] of m.questions.entries()) {
      const at = `questions[${i}]`;
      if (!isObj(q) || typeof q.label !== "string") {
        errs.push(`${at}: needs string key and label`);
        continue;
      }
      if (!isKey(q.key)) {
        errs.push(`${at}.key: ${keyProblem(q.key)}`);
        continue;
      }
      if (seen.has(q.key)) errs.push(`${at}: duplicate key "${q.key}"`);
      seen.add(q.key);
      if (q.type === "choice") {
        if (q.options !== "rows" && q.options !== "cols") axes(q.options, `${at}.options`, errs);
      } else if (q.type === "number") {
        if (
          !Number.isInteger(q.min) ||
          !Number.isInteger(q.max) ||
          (q.min as number) > (q.max as number)
        )
          errs.push(`${at}: number needs integer min <= max`);
      } else if (q.type !== "text") errs.push(`${at}: type must be choice, number or text`);
    }
  }

  if (!Array.isArray(m.items) || m.items.length === 0)
    errs.push("items: must be a non-empty array");
  else {
    const seen = new Set<string>();
    for (const [i, it] of m.items.entries()) {
      const at = `items[${i}]`;
      if (!isObj(it)) {
        errs.push(`${at}: needs string id`);
        continue;
      }
      if (!isKey(it.id)) {
        errs.push(`${at}.id: ${keyProblem(it.id)}`);
        continue;
      }
      if (seen.has(it.id)) errs.push(`${at}: duplicate id "${it.id}"`);
      seen.add(it.id);
      if (it.ref !== undefined && !isImagePath(it.ref))
        errs.push(`${at}.ref: unsafe path or not an image`);
      if (!isObj(it.cells)) {
        errs.push(`${at}.cells: must be an object`);
        continue;
      }
      for (const [r, byCol] of Object.entries(it.cells)) {
        if (!rows.has(r)) errs.push(`${at}.cells: unknown row "${r}"`);
        if (!isObj(byCol)) {
          errs.push(`${at}.cells.${r}: must be an object`);
          continue;
        }
        for (const [c, p] of Object.entries(byCol)) {
          if (!cols.has(c)) errs.push(`${at}.cells.${r}: unknown col "${c}"`);
          if (!isImagePath(p)) errs.push(`${at}.cells.${r}.${c}: unsafe path or not an image`);
        }
      }
      if (it.metrics !== undefined) {
        if (!isObj(it.metrics)) errs.push(`${at}.metrics: must be an object`);
        else
          for (const [r, vals] of Object.entries(it.metrics)) {
            if (!rows.has(r)) errs.push(`${at}.metrics: unknown row "${r}"`);
            else if (
              !isObj(vals) ||
              !Object.values(vals).every((v) => typeof v === "number" || typeof v === "string")
            )
              errs.push(`${at}.metrics.${r}: must map names to numbers or strings`);
          }
      }
    }
  }
  return errs;
}

/** Every image path the manifest refers to, deduplicated. */
export function imagePaths(m: Manifest): string[] {
  const out = new Set<string>();
  for (const it of m.items) {
    if (it.ref) out.add(it.ref);
    for (const byCol of Object.values(it.cells)) for (const p of Object.values(byCol)) out.add(p);
  }
  return [...out];
}

export function choiceKeys(m: Manifest, q: Extract<Question, { type: "choice" }>): string[] {
  const opts = q.options === "rows" ? m.rows : q.options === "cols" ? m.cols : q.options;
  return opts.map((o) => o.key);
}

/** Returns the problems with a submitted answer set; unanswered questions (absent or null) are allowed. */
export function validateAnswers(m: Manifest, a: unknown): string[] {
  if (!isObj(a)) return ["answers must be an object"];
  const errs: string[] = [];
  const byKey = new Map(m.questions.map((q) => [q.key, q]));
  for (const [k, v] of Object.entries(a)) {
    const q = byKey.get(k);
    if (!q) {
      errs.push(`unknown question "${k}"`);
      continue;
    }
    if (v === null) continue;
    if (q.type === "choice" && !(typeof v === "string" && choiceKeys(m, q).includes(v)))
      errs.push(`${k}: not one of the options`);
    if (
      q.type === "number" &&
      !(Number.isInteger(v) && (v as number) >= q.min && (v as number) <= q.max)
    )
      errs.push(`${k}: must be an integer in ${q.min}..${q.max}`);
    if (q.type === "text" && !(typeof v === "string" && v.length <= 2000))
      errs.push(`${k}: must be text up to 2000 chars`);
  }
  return errs;
}
