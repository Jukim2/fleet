// Read/clear the planner Claude's output file (<cwd>/.fleet/plan.json).
import { invoke } from "@tauri-apps/api/core";

export const readPlan = (cwd: string) => invoke<string | null>("read_plan", { cwd });
export const clearPlan = (cwd: string) => invoke<void>("clear_plan", { cwd });

/**
 * The prompt we hand the planner Claude. It must ONLY plan + write the file.
 * `existingThemes` are the project's current top-level themes — the planner
 * reuses a matching one (same title) so new work attaches to it instead of
 * starting a disconnected plan.
 */
export function plannerPrompt(goal: string, existingThemes: string[] = []): string {
  const themesLine = existingThemes.length
    ? `이미 있는 테마: ${existingThemes.map((t) => `"${t}"`).join(", ")}. 새 작업이 이 중 하나에 속하면 그 테마의 title을 그대로 써서 거기에 붙이세요. 아니면 새 테마를 만드세요.`
    : "아직 테마가 없습니다. 적절한 큰 테마부터 만드세요.";
  return [
    "당신은 '플래너'입니다. 아래 목표를 실제로 구현하지 말고, 작업 계획만 세우세요.",
    "구조는 3단계입니다: 테마(큰 주제, 예: 'UI 개선') → 기능(feature) → 단계(step).",
    themesLine,
    "각 step의 'prompt'에는 그 단계를 수행할 새 Claude Code 세션에게 줄 구체적 지시문을 적습니다.",
    "중요: 순서가 있는 단계는 반드시 deps로 연결하세요. 예) 구현→테스트라면 테스트 step의 deps에 구현 step의 key를 넣습니다. deps에는 다른 step의 key를 정확히 그대로 적습니다 (다른 기능의 step도 가능). 진짜로 병렬 가능한 단계만 deps를 비웁니다.",
    "결과를 아래 JSON 스키마로 ./.fleet/plan.json 파일에만 저장하세요 (폴더 없으면 생성). 그 외 출력/구현 금지.",
    "",
    "{",
    '  "themes": [',
    '    { "key": "UI", "title": "<테마명>", "features": [',
    '      { "key": "A", "title": "<기능명>", "steps": [',
    '        { "key": "A-1", "title": "<단계명>", "prompt": "<이 단계 지시문>", "deps": [] }',
    "      ]}",
    "    ]}",
    "  ]",
    "}",
    "",
    `목표: ${goal}`,
  ].join("\n");
}
