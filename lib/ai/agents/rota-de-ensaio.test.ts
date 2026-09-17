// @vitest-environment node
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  SEGMENTO_DE_ENSAIO,
  TIMEOUT_MS_DO_ENSAIO,
  urlEnsaioDoAgente,
} from "@/lib/ai/agents/rota-de-ensaio";

describe("urlEnsaioDoAgente", () => {
  it("não usa o segmento test", () => {
    const url = urlEnsaioDoAgente("a", "b");
    expect(url.endsWith("/dry-run")).toBe(true);
    expect(url).not.toMatch(/\/test$/);
    expect(SEGMENTO_DE_ENSAIO).toBe("dry-run");
    expect(TIMEOUT_MS_DO_ENSAIO).toBe(120_000);
    expect(
      existsSync(join(process.cwd(), "app/api/v1/ai/agents/[id]/versions/[vid]/test")),
    ).toBe(false);
  });
});
