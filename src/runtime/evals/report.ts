export interface StageEvalResult {
  fixtureId: string;
  stage: string;
  score: number;
  passed: boolean;
  notes: string;
  skipped?: boolean;
}

export function renderEvalReport(results: StageEvalResult[]): string {
  const lines = ["Jantra eval report", ""];
  for (const result of results) {
    if (result.skipped) {
      lines.push(`SKIP ${result.fixtureId} ${result.stage}: ${result.notes}`);
      continue;
    }
    lines.push(
      `${result.passed ? "PASS" : "FAIL"} ${result.fixtureId} ${result.stage}: ${result.score}/5 - ${result.notes}`,
    );
  }
  const scored = results.filter((result) => !result.skipped);
  const passed = scored.filter((result) => result.passed).length;
  const skipped = results.length - scored.length;
  lines.push("");
  lines.push(`Summary: ${passed}/${scored.length} checks passed, ${skipped} skipped.`);
  return lines.join("\n");
}
