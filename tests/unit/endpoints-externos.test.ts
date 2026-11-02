/**
 * A tela /admin/endpoints não anuncia porta que não abre: cada linha de
 * `ENDPOINTS_EXTERNOS` passa pelo `proxy.ts` (está em `PUBLIC_PATHS`, senão o
 * Bearer leva 401 antes do handler), e o arquivo da rota exporta o método e
 * exige o escopo anunciado.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ENDPOINTS_EXTERNOS } from "@/lib/api/endpoints-externos";
import { PUBLIC_PATHS } from "@/lib/auth/public-paths";

const UUID = "11111111-1111-4111-8111-111111111111";

describe("endpoints para sistemas externos", () => {
  it.each(ENDPOINTS_EXTERNOS.map((e) => [`${e.metodo} ${e.caminho}`, e] as const))("%s", (_nome, e) => {
    const caminho = e.caminho.replace(":id", UUID);
    expect(PUBLIC_PATHS.some((r) => r.test(caminho)), "fora de PUBLIC_PATHS: o proxy barra o Bearer").toBe(true);
    const fonte = readFileSync(join(process.cwd(), e.arquivo), "utf8");
    expect(fonte).toContain(`export async function ${e.metodo}(`);
    expect(fonte).toContain(e.escopo);
  });

  it("a página do admin tem porta no menu", () => {
    // A lista do menu do admin mora em lib/admin/navegacao.ts desde a v1.98.0.
    const menu = readFileSync(join(process.cwd(), "lib/admin/navegacao.ts"), "utf8");
    expect(menu).toContain('href: "/admin/endpoints"');
  });
});
