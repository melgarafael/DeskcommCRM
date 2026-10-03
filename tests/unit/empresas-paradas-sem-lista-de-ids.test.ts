/**
 * AS VARREDURAS NÃO MONTAM MAIS A LISTA DE IDS DE ORG PARADA NA URL (issue #2015).
 *
 * `idsDeOrgsParadas()` buscava todas as orgs não operantes e cada chamador
 * negava `not(organization_id, in, (...))` no PostgREST (ou `<> all` no SQL do
 * worker). Num revendedor com muitas empresas paradas a URL crescia sem teto e,
 * acima de `max_rows = 1000` (`supabase/config.toml`), a lista voltava cortada
 * SEM aviso — as empresas além do corte voltavam a disparar/avançar/ingerir.
 *
 * Este arquivo mede por AST/texto que NENHUM dos cinco chamadores monta essa
 * lista: manda embutir o status da org no próprio `select` (join no banco) e
 * decidir com `ehOperante`, ou usar a régua SQL `fn_org_operante` no worker. É
 * VERMELHO no código que veio com o #1987 (todos usavam `idsDeOrgsParadas` +
 * `.not in`) e VERDE depois desta mudança.
 *
 * O mesmo padrão que as outras cercas do repo (ex.
 * `org-operante-uma-regua.test.ts`): lê o código do disco, não roda o runtime.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = join(__dirname, "..", "..");

const CHAMADORES = [
  "lib/campanhas/rodada.ts",
  "lib/prospecting/worker.ts",
  "lib/relogio/executar.ts",
  "app/api/v1/cron/agenda-reminder/route.ts",
  "app/api/v1/cron/kb-conversations-batch/route.ts",
] as const;

/** O anti-padrão que a issue #2015 quer ver fora dos chamadores. */
const PROIBIDOS = [/\bidsDeOrgsParadas\(/g, /\.not\("organization_id",\s*"in"/g, /<> all\(\$/g];

/**
 * O que cada chamador PRECISA usar para filtrar no banco, no lugar da lista: o
 * embed com `!inner` E o filtro `organizations.status` na própria consulta — é o
 * que faz o corte sair ANTES do `limit` (filtrar só em memória deixa a linha da
 * org parada ocupar a janela). O `ehOperante` em memória fica como cinto.
 */
const EMBED_INNER = /organizations:organization_id!inner\(status\)/;
const FILTRO_NO_BANCO = /\.eq\("organizations\.status",\s*STATUS_OPERANTE\)/;
const EXIGIDO: Record<(typeof CHAMADORES)[number], RegExp[]> = {
  "lib/campanhas/rodada.ts": [EMBED_INNER, FILTRO_NO_BANCO, /\behOperante\(/],
  "lib/prospecting/worker.ts": [/fn_org_operante\(/],
  "lib/relogio/executar.ts": [EMBED_INNER, FILTRO_NO_BANCO, /\behOperante\(/],
  "app/api/v1/cron/agenda-reminder/route.ts": [EMBED_INNER, FILTRO_NO_BANCO, /\behOperante\(/],
  "app/api/v1/cron/kb-conversations-batch/route.ts": [EMBED_INNER, FILTRO_NO_BANCO, /\behOperante\(/],
};

function fonteDe(rel: string): string {
  return readFileSync(join(RAIZ, rel), "utf8");
}

describe("empresas paradas não viram lista de ids na URL", () => {
  it.each(CHAMADORES)("nenhuma varredura monta a lista de ids de org parada: %s", (rel) => {
    const fonte = fonteDe(rel);
    for (const proibido of PROIBIDOS) {
      expect(fonte.match(proibido), `${rel} não pode usar ${proibido}`).toBeNull();
    }
  });

  it.each(CHAMADORES)("filtra no banco (embed de status + ehOperante, ou fn_org_operante): %s", (rel) => {
    const fonte = fonteDe(rel);
    for (const exigido of EXIGIDO[rel]) {
      expect(fonte.match(exigido), `${rel} precisa de ${exigido}`).not.toBeNull();
    }
  });

  it("a régua continua exportando o par SQL (a lista de ids continua onde quem decide é o banco)", () => {
    const operante = fonteDe("lib/organizacao/operante.ts");
    expect(operante).toMatch(/export async function idsDeOrgsParadas/);
    expect(operante).toMatch(/export function statusDaOrgEmbutida/);
  });
});