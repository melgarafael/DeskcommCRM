import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lastLine, sql } from "./gov-helpers";

// O mesmo SQL executa contra o baseline real do harness oficial.
// Spies transacionais medem recálculo, não latência de hardware.
describe("papel único nos helpers de visibilidade", () => {
  it("preserva decisões por linha e não repete papel nem abre caminho para master", () => {
    const source = readFileSync(new URL("./visibilidade-papel-unico.sql", import.meta.url), "utf8");
    const lines = sql(source).split("\n").filter((line) => line.startsWith("{"));
    expect(lines).toHaveLength(1);
    const result = JSON.parse(lastLine(lines.join("\n"))) as { checks: number; failures: number; failed_labels: string[] };
    expect(result.checks).toBe(116);
    expect(result.failed_labels).toEqual([]);
    expect(result.failures).toBe(0);
  });
});
