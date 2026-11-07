import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("cron avaliacao-atrasados", () => {
  it("só chama audit quando houve efeito (atualizados > 0)", () => {
    const src = readFileSync(join(import.meta.dirname, "route.ts"), "utf8");
    expect(src).toMatch(/if\s*\(\s*atualizados\s*>\s*0\s*\)/);
    expect(src).toMatch(/audit\s*\(\s*\{/);
    expect(src).not.toMatch(/void audit\([\s\S]*?\)\s*;[\s\S]*?return ok\(\{ atualizados: 0/);
  });
});
