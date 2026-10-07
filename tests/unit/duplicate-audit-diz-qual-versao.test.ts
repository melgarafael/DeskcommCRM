/**
 * O audit de `ai_agent.duplicated` precisa dizer QUAL versão foi clonada.
 *
 * Como o defeito entrou: a reescrita que extraiu `duplicateAgentWithVersion` deixou
 * o helper sem devolver a versão de ORIGEM, e a rota — que antes emitia
 * `source_version_id: srcVersion.id` — passou a emitir só `source_agent_id`. O merge
 * da main carregou a perda, porque o lado da branch era o mais novo naquele arquivo.
 *
 * Por que 2600 testes ficaram verdes por cima: NENHUM olhava o metadata do audit.
 * `audit()` é fire-and-forget por contrato (não bloqueia a mutação), então perder um
 * campo não quebra request, não muda status e não aparece em teste de rota.
 *
 * Por que isso importa mais que um campo a menos: `api_audit_log` é append-only por
 * doutrina — linha emitida pobre NÃO se enriquece depois. O registro de "de qual
 * versão veio esta cópia" some para sempre, e é exatamente a pergunta que alguém faz
 * quando uma cópia sai diferente do esperado.
 *
 * Guarda os DOIS emissores da mesma ação: a rota REST e o botão da lista. Eles
 * divergiam (`source_version_id` num, `source_version_copied` no outro), e metadata
 * de forma diferente para a mesma ação faz quem lê o log concluir errado — "o campo
 * faltou porque não houve versão" vs "porque veio pelo outro caminho".
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROTA = "app/api/v1/ai/agents/[id]/duplicate/route.ts";
const ACAO = "app/app/ai/agents/_actions.ts";

function fonte(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

/** Recorta o bloco `metadata: { ... }` que acompanha `ai_agent.duplicated`. */
function metadataDoDuplicated(rel: string): string {
  const src = fonte(rel);
  const i = src.indexOf('action: "ai_agent.duplicated"');
  expect(i, `emissor de ai_agent.duplicated sumiu de ${rel}`).toBeGreaterThan(-1);
  const j = src.indexOf("metadata:", i);
  expect(j, `bloco metadata sumiu de ${rel}`).toBeGreaterThan(i);
  return src.slice(j, j + 400);
}

describe("audit de duplicação diz de qual versão veio a cópia", () => {
  it.each([
    ["rota REST", ROTA],
    ["botão da lista", ACAO],
  ])("%s emite source_version_id", (_n, rel) => {
    expect(metadataDoDuplicated(rel)).toMatch(/source_version_id/);
  });

  it.each([
    ["rota REST", ROTA],
    ["botão da lista", ACAO],
  ])("%s continua emitindo source_agent_id (não trocar um pelo outro)", (_n, rel) => {
    expect(metadataDoDuplicated(rel)).toMatch(/source_agent_id/);
  });

  it("os dois emissores da MESMA ação têm a mesma forma de metadata", () => {
    // Sem isto, um emissor evolui e o outro fica para trás — foi assim que a
    // divergência nasceu. Compara o CONJUNTO de chaves, não a ordem.
    const chaves = (rel: string) =>
      [...metadataDoDuplicated(rel).matchAll(/^\s*([a-z_]+):/gm)]
        .map((m) => m[1])
        .filter((k) => k !== "metadata")
        .sort();

    const daRota = chaves(ROTA);
    expect(daRota.length, "controle de vacuidade: nenhuma chave extraída").toBeGreaterThan(1);
    expect(chaves(ACAO)).toEqual(daRota);
  });

  it("o helper devolve a versão de ORIGEM, que é o que torna o campo possível", () => {
    // Âncora no fonte: se `sourceVersionId` sumir do retorno, os emissores acima
    // passam a mandar `undefined` — e `undefined` em metadata some no JSON, sem erro.
    const src = fonte("lib/ai/agents/duplicate.ts");
    expect(src, "o tipo do resultado não expõe a versão de origem").toMatch(
      /sourceVersionId:\s*string \| null/,
    );
    // `ok: true` com VÍRGULA = os returns; o `ok: true;` do tipo usa ponto-e-vírgula.
    // A guarda é "TODO return de sucesso preenche o campo", não QUANTOS returns
    // existem: o #2296 uniu os dois num só e a cerca, que contava 2, reprovou
    // um código que cumpria a intenção.
    const retornos = [...src.matchAll(/ok:\s*true,/g)];
    expect(retornos.length, "controle de vacuidade: nenhum return de sucesso achado").toBeGreaterThanOrEqual(1);
    for (const r of retornos) {
      const corpo = src.slice(r.index, src.indexOf("}", r.index));
      expect(corpo, "return de sucesso sem sourceVersionId").toMatch(/sourceVersionId:/);
    }
  });
});
