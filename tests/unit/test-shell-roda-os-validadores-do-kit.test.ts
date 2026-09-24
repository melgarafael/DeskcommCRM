/**
 * `pnpm test:shell` roda `hostgator-setup-kit/test-validators.sh`.
 *
 * É ele que cobre o `install.sh` (issue #191: os casos existiam e não rodavam
 * em job nenhum). Entrou no `test:shell` em 2026-08-08 e SAIU em silêncio em
 * 2026-09-19, na resolução de conflito do merge do #1278 no `package.json` —
 * e o comentário do step "Kit self-host (bash)" do `ci.yml` seguiu afirmando
 * que ele roda. Gate ausente não fica vermelho nem verde: este teste é o que
 * faz a próxima saída ficar vermelha.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("test:shell", () => {
  it("roda os validadores do instalador", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["test:shell"]).toContain("bash hostgator-setup-kit/test-validators.sh");
  });
});
