// External-tool manifests — the data that turns a CLI tool into a GUI.
//
// A manifest describes one sibling tool (today: SpriteForge's headless runner):
// its modes, each mode's options as a form schema (selects/numbers/bools map
// 1:1 to CLI flags), how to build the argv, and how to recognize the tool when
// a claude session invokes it (PreToolUse Bash detail → live tool node).

export type ToolValues = Record<string, string | number | boolean>;

export type ToolOption = {
  key: string;
  /** CLI flag, e.g. "--model". kind "flag" appends it bare when true;
   *  "negFlag" appends it when the value is FALSE (e.g. --no-recursive). */
  flag: string;
  kind: "value" | "flag" | "negFlag";
  label: string;
  type: "select" | "number" | "text" | "bool" | "color";
  choices?: string[];
  default: string | number | boolean;
  min?: number;
  max?: number;
  step?: number;
  hint?: string;
  /** optional value: skip the flag entirely when left empty (text/number) */
  optional?: boolean;
};

export type ToolMode = {
  id: string; // --tool value (or {mode} in a custom args template)
  label: string;
  desc: string;
  icon: string;
  /** per-mode launch program — overrides the manifest's. Optional. */
  program?: string;
  /** per-mode argv template with placeholders {input} {outDir} {mode} {options}.
   *  Absent = the legacy shape `[…scriptArgs, <input>, --tool <mode>, …opts, --out <outDir>]`. */
  args?: string[];
  options: ToolOption[];
};

export type ToolManifest = {
  id: string;
  name: string;
  /** one-line description of what the tool is (optional). */
  desc?: string;
  /** default launch program relative to the tool root. Optional: a detect-only
   *  tool (observed, not Fleet-launched) needs none. A mode may override it. */
  program?: string;
  /** legacy fixed args placed before <input> (optional). */
  scriptArgs?: string[];
  /** one OR MORE regexes recognizing this tool in a claude Bash/Skill command
   *  (universal detection — any command shape). Absent = no live-node detection. */
  detect?: RegExp | RegExp[];
  /** output subfolder the CLI writes into (under the input dir). */
  outDirName: string;
  /** modes describe what the tool can do (shown as capabilities). Optional. */
  modes: ToolMode[];
};

const sel = (
  key: string,
  flag: string,
  label: string,
  choices: string[],
  def: string,
  hint?: string,
): ToolOption => ({ key, flag, kind: "value", label, type: "select", choices, default: def, hint });
const num = (
  key: string,
  flag: string,
  label: string,
  def: number,
  extra?: Partial<ToolOption>,
): ToolOption => ({ key, flag, kind: "value", label, type: "number", default: def, ...extra });
const flag = (key: string, f: string, label: string, def: boolean, hint?: string): ToolOption => ({
  key,
  flag: f,
  kind: "flag",
  label,
  type: "bool",
  default: def,
  hint,
});

/** shared 1→1 raster output options */
const FORMAT_OPTS: ToolOption[] = [
  sel("format", "--format", "출력 포맷", ["png", "webp"], "png"),
];
const GPU_OPT = flag(
  "requireGpu",
  "--require-gpu",
  "GPU 필수",
  true,
  "WebGPU를 못 쓰면 조용히 CPU로 느리게 돌지 않고 실패해요",
);
const RECURSIVE_OPT: ToolOption = {
  key: "recursive",
  flag: "--no-recursive",
  kind: "negFlag",
  label: "하위 폴더 포함",
  type: "bool",
  default: true,
};

export const SPRITEFORGE: ToolManifest = {
  id: "spriteforge",
  name: "SpriteForge",
  program: "node",
  scriptArgs: ["scripts/sf-headless.mjs"],
  detect: /sf-headless\.mjs|sprite-batch/i,
  outDirName: "_out",
  modes: [
    {
      id: "upscale",
      label: "업스케일",
      desc: "AI(Real-ESRGAN)/xBR로 확대",
      icon: "⤢",
      options: [
        sel("algo", "--algo", "알고리즘", ["ai", "xbr", "smooth", "nearest"], "ai"),
        sel(
          "model",
          "--model",
          "모델",
          ["anime-best", "general-best", "anime", "general"],
          "anime-best",
          "게임/일러스트풍은 anime-best",
        ),
        sel("scale", "--scale", "배율", ["2", "3", "4"], "4"),
        ...FORMAT_OPTS,
        GPU_OPT,
        RECURSIVE_OPT,
      ],
    },
    {
      id: "bgremove",
      label: "배경 제거",
      desc: "AI 배경 제거 → 투명 PNG/WebP",
      icon: "✂",
      options: [
        sel(
          "model",
          "--model",
          "모델",
          ["anime-isnet", "toonout", "birefnet-matting", "rmbg14", "isnet", "isnet_fp16", "isnet_quint8"],
          "anime-isnet",
          "GPU 배경 제거는 anime-isnet 권장 · isnet 계열은 CPU 전용",
        ),
        ...FORMAT_OPTS,
        GPU_OPT,
        RECURSIVE_OPT,
      ],
    },
    {
      id: "slice",
      label: "시트 분할",
      desc: "스프라이트 시트 → 개별 스프라이트",
      icon: "▦",
      options: [
        flag("auto", "--auto", "자동 감지", true, "끄면 아래 격자 크기로 자름"),
        {
          key: "grid",
          flag: "--grid",
          kind: "value",
          label: "격자 (WxH)",
          type: "text",
          default: "64x64",
          optional: true,
          hint: "자동 감지 꺼짐일 때만 사용",
        },
        num("mergeGap", "--merge-gap", "병합 간격(px)", 0, { min: 0, max: 64, optional: true }),
        RECURSIVE_OPT,
      ],
    },
    {
      id: "chromakey",
      label: "크로마키",
      desc: "지정 색 배경 제거 (그린스크린)",
      icon: "🎯",
      options: [
        {
          key: "color",
          flag: "--color",
          kind: "value",
          label: "키 색상",
          type: "color",
          default: "#00ff00",
        },
        num("tolerance", "--tolerance", "허용치", 20, { min: 0, max: 100 }),
        num("despill", "--despill", "색 번짐 제거", 0.5, { min: 0, max: 1, step: 0.05, optional: true }),
        ...FORMAT_OPTS,
        RECURSIVE_OPT,
      ],
    },
    {
      id: "vectorize",
      label: "벡터화",
      desc: "래스터 → SVG",
      icon: "✒",
      options: [
        sel("mode", "--mode", "방식", ["pixel", "trace"], "pixel", "픽셀아트는 pixel"),
        num("colors", "--colors", "색 수", 4, { min: 1, max: 8, optional: true }),
        RECURSIVE_OPT,
      ],
    },
    {
      id: "compress",
      label: "압축",
      desc: "재인코딩 (WebP 등, 리사이즈 없음)",
      icon: "🗜",
      options: [
        flag("webp", "--webp", "WebP로", true),
        num("quality", "--quality", "품질", 80, { min: 1, max: 100 }),
        RECURSIVE_OPT,
      ],
    },
    {
      id: "extract",
      label: "프레임 추출",
      desc: "비디오 → 프레임 이미지",
      icon: "🎞",
      options: [
        num("interval", "--interval", "간격(초)", 0.5, { min: 0.05, step: 0.05, optional: true }),
        num("start", "--start", "시작(초)", 0, { min: 0, optional: true }),
        num("end", "--end", "끝(초)", 0, { min: 0, optional: true }),
        RECURSIVE_OPT,
      ],
    },
    {
      id: "gif",
      label: "GIF 조립",
      desc: "프레임 폴더 → 애니메이션 GIF",
      icon: "🌀",
      options: [
        num("fps", "--fps", "FPS", 12, { min: 1, max: 60 }),
        {
          key: "suffix",
          flag: "--suffix",
          kind: "value",
          label: "파일명",
          type: "text",
          default: "",
          optional: true,
        },
      ],
    },
  ],
};

export const TOOL_MANIFESTS: Record<string, ToolManifest> = {
  [SPRITEFORGE.id]: SPRITEFORGE,
};

/**
 * Parse + validate a `fleet-tool.json` blob (the tool-integration policy —
 * see docs/EXTERNAL_TOOLS.md) into a runtime manifest. Throws a Korean,
 * user-showable message on any structural problem.
 */
export function parseToolManifest(raw: unknown): ToolManifest {
  const fail = (msg: string): never => {
    throw new Error(`fleet-tool.json: ${msg}`);
  };
  if (typeof raw !== "object" || raw === null) fail("JSON 객체가 아니에요");
  const j = raw as Record<string, unknown>;
  const str = (k: string, required = true): string => {
    const v = j[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (required) fail(`"${k}" 문자열이 필요해요`);
    return "";
  };
  const id = str("id");
  if (!/^[a-z0-9-]+$/.test(id)) fail(`"id"는 소문자·숫자·하이픈만 가능해요 (현재: ${id})`);
  const name = str("name");
  const desc = str("desc", false) || undefined;
  const program = str("program", false) || undefined;
  const scriptArgs = Array.isArray(j.scriptArgs) ? j.scriptArgs.map(String) : undefined;
  const outDirName = str("outDirName", false) || "_out";
  // detect: string | string[] → RegExp[] (universal, multi-CLI)
  const detectRaw = Array.isArray(j.detect) ? j.detect : j.detect ? [j.detect] : [];
  const detect: RegExp[] = [];
  for (const d of detectRaw) {
    if (typeof d !== "string" || !d) continue;
    try {
      detect.push(new RegExp(d, "i"));
    } catch {
      fail(`"detect" 정규식이 잘못됐어요: ${d}`);
    }
  }
  const modesRaw = Array.isArray(j.modes) ? j.modes : [];
  if (detect.length === 0 && modesRaw.length === 0)
    fail(`"detect"(감지 패턴) 또는 "modes"(실행 모드) 중 하나는 있어야 해요`);
  const OPT_KINDS = ["value", "flag", "negFlag"];
  const OPT_TYPES = ["select", "number", "text", "bool", "color"];
  const modes: ToolMode[] = modesRaw.map((m, i) => {
    if (typeof m !== "object" || m === null) fail(`modes[${i}]가 객체가 아니에요`);
    const mm = m as Record<string, unknown>;
    const mid = typeof mm.id === "string" && mm.id ? mm.id : fail(`modes[${i}].id가 필요해요`);
    const options: ToolOption[] = (Array.isArray(mm.options) ? mm.options : []).map((o, k) => {
      if (typeof o !== "object" || o === null) fail(`modes[${i}].options[${k}]가 객체가 아니에요`);
      const oo = o as Record<string, unknown>;
      const kind = String(oo.kind ?? "value");
      const type = String(oo.type ?? "text");
      if (!OPT_KINDS.includes(kind)) fail(`옵션 kind "${kind}"는 value|flag|negFlag 중 하나여야 해요`);
      if (!OPT_TYPES.includes(type)) fail(`옵션 type "${type}"는 ${OPT_TYPES.join("|")} 중 하나여야 해요`);
      if (typeof oo.key !== "string" || !oo.key) fail(`modes[${i}].options[${k}].key가 필요해요`);
      if (typeof oo.flag !== "string" || !oo.flag) fail(`옵션 "${oo.key}"의 flag가 필요해요`);
      if (type === "select" && (!Array.isArray(oo.choices) || oo.choices.length === 0))
        fail(`select 옵션 "${oo.key}"엔 choices 배열이 필요해요`);
      return {
        key: oo.key as string,
        flag: oo.flag as string,
        kind: kind as ToolOption["kind"],
        type: type as ToolOption["type"],
        label: typeof oo.label === "string" && oo.label ? oo.label : (oo.key as string),
        choices: Array.isArray(oo.choices) ? oo.choices.map(String) : undefined,
        default: (oo.default ?? (type === "bool" ? false : "")) as ToolOption["default"],
        min: typeof oo.min === "number" ? oo.min : undefined,
        max: typeof oo.max === "number" ? oo.max : undefined,
        step: typeof oo.step === "number" ? oo.step : undefined,
        hint: typeof oo.hint === "string" ? oo.hint : undefined,
        optional: oo.optional === true,
      };
    });
    return {
      id: mid as string,
      label: typeof mm.label === "string" && mm.label ? mm.label : (mid as string),
      desc: typeof mm.desc === "string" ? mm.desc : "",
      icon: typeof mm.icon === "string" && mm.icon ? mm.icon : "⚙",
      program: typeof mm.program === "string" && mm.program ? mm.program : undefined,
      args: Array.isArray(mm.args) ? mm.args.map(String) : undefined,
      options,
    };
  });
  return {
    id,
    name,
    desc,
    program,
    scriptArgs,
    detect: detect.length ? detect : undefined,
    outDirName,
    modes,
  };
}

/** built-ins + user-connected custom tools (custom wins on id collision) */
export function mergeManifests(customTools?: Record<string, unknown>): Record<string, ToolManifest> {
  const all: Record<string, ToolManifest> = { ...TOOL_MANIFESTS };
  for (const raw of Object.values(customTools ?? {})) {
    try {
      const m = parseToolManifest(raw);
      all[m.id] = m;
    } catch {
      /* invalid persisted manifest — skip silently, re-connect to fix */
    }
  }
  return all;
}

/** join an input dir with a tool's output subfolder (used by the live node's
 *  best-effort before→after preview of what a claude session ran). */
export function toolOutDir(manifest: ToolManifest, inputDir: string): string {
  const sep = inputDir.includes("\\") ? "\\" : "/";
  return inputDir.replace(/[\\/]+$/, "") + sep + manifest.outDirName;
}

/** which manifest (if any) a claude Bash invocation belongs to */
export function detectToolUse(
  manifests: Record<string, ToolManifest>,
  toolName: string,
  detail: string,
): ToolManifest | null {
  if (toolName !== "Bash" && toolName !== "Skill") return null;
  for (const m of Object.values(manifests)) {
    const pats = Array.isArray(m.detect) ? m.detect : m.detect ? [m.detect] : [];
    if (pats.some((re) => re.test(detail))) return m;
  }
  return null;
}

/** progress parsing for sf-headless output lines. Verified shapes:
 *    "SpriteForge headless — 12 file(s)"                      → total
 *    "  [3/12] name.png ... done 256x256 [webgpu] (1.2s)"     → one success
 *    "  [4/12] bad.png ... FAILED — reason"                   → one failure
 *    "done — 64x64, 3 frames (0.4s)"                          → gif (single unit) */
export function parseToolLine(line: string): {
  total?: number;
  done?: boolean;
  failed?: boolean;
} {
  const head = /headless — (\d+) /.exec(line);
  if (head) return { total: Number(head[1]) };
  const perFile = /\[\d+\/\d+\]/.test(line) || /^done\b/.test(line.trim());
  if (perFile && /\bdone\b/.test(line)) return { done: true };
  if (/\bFAILED\b/.test(line)) return { failed: true };
  return {};
}
