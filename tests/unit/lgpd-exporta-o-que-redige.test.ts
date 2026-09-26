import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * O QUE SE APAGA A PEDIDO DO TITULAR É O QUE SE ENTREGA A PEDIDO DELE.
 *
 * ═══ O defeito que este arquivo fecha ═══
 *
 * A migration 0184 declarou `calendar_appointments` dado pessoal e ligou o
 * trigger de REDAÇÃO. A mesma entrega escreveu
 * `tests/invariants/agenda-lgpd-alcanca.test.ts` — quatro casos, com controle
 * positivo — para provar que a redação alcança a tabela.
 *
 * E ninguém acrescentou a agenda ao EXPORT. O titular exercia o Art. 18 II e
 * recebia um relatório que não mencionava nenhuma consulta que ele marcou.
 *
 * A entrega construiu o gate de UMA metade da LGPD e nenhum da outra. Não foi
 * descuido de quem escreveu: `lib/lgpd/export-collector.ts` não tem lista
 * declarada em lugar nenhum — os blocos são escritos à mão, um a um, e
 * `workers/lgpd-export-worker.ts` se autodescreve como "8-table aggregator"
 * com contagem FIXA no comentário. Tabela nova simplesmente não aparece.
 *
 * ═══ Por que a lista é DERIVADA, e não escrita aqui ═══
 *
 * Uma lista fixa neste arquivo reproduziria o defeito num arquivo a mais: a
 * oitava tabela redigida entraria sem ninguém acrescentá-la aqui, e o teste
 * ficaria verde por não medir. As duas pontas saem da fonte:
 *
 *   limpeza → toda função do baseline cujo nome case /redact|redigir|anonimiz|apagar/,
 *             pelos alvos de `update <tabela> set` E de `delete from <tabela>` no corpo dela
 *   export  → os `.from("<tabela>")` de `lib/lgpd/export-collector.ts`
 *
 * O `delete from` entrou DEPOIS: a varredura nasceu só de `update ... set`, em
 * função com `redact|redigir` no nome — e a anonimização que APAGA se chama
 * `fn_apagar_...`.
 * ═══ O que este teste NÃO prova ═══
 *
 * Que o conteúdo exportado seja suficiente — só que a tabela é VISITADA.
 * E não olha o PDF: `activities` está no payload e não no relatório, o que é
 * legítimo (o worker sobe `data.json` E `report.pdf`, e o JSON leva tudo).
 */

const RAIZ = path.resolve(__dirname, "../..");
const BASELINE = fs.readFileSync(path.join(RAIZ, "supabase/baseline.sql"), "utf8");
const COLETOR = fs.readFileSync(path.join(RAIZ, "lib/lgpd/export-collector.ts"), "utf8");

/** Corpos de função cujo NOME anuncia limpeza de dado pessoal — redigir OU apagar.
 *  No dump vêm com identificador entre aspas. */
function corposDeLimpeza(): string[] {
  const corpos: string[] = [];
  const abre =
    /create or replace function\s+"?public"?\.\s*"?([a-z_]*(?:redact|redigir|anonimiz|apagar)[a-z_]*)"?/gi;
  for (const m of BASELINE.matchAll(abre)) {
    const inicio = m.index ?? 0;
    // O corpo termina no primeiro `$$;` depois da abertura. Os dumps deste repo
    // usam `$$` e `$pub$`; ambos fecham com `$;`.
    const fim = BASELINE.indexOf("$;", inicio);
    corpos.push(BASELINE.slice(inicio, fim === -1 ? BASELINE.length : fim));
  }
  return corpos;
}

/** Tabelas que a limpeza alcança: `update <t> set` (redige) ou `delete from <t>` (apaga). */
function tabelasDeLimpeza(): string[] {
  const alvos = new Set<string>();
  for (const corpo of corposDeLimpeza()) {
    for (const m of corpo.matchAll(
      /\b(?:update\s+(?:"?public"?\.)?"?([a-z_]+)"?\s+set|delete\s+from\s+(?:"?public"?\.)?"?([a-z_]+)"?)/gi,
    )) {
      const t = m[1] ?? m[2];
      if (t !== undefined) alvos.add(t);
    }
  }
  return [...alvos].sort();
}

function tabelasExportadas(): string[] {
  return [...COLETOR.matchAll(/\.from\("([a-z_]+)"\)/g)]
    .map((m) => m[1])
    .filter((t): t is string => t !== undefined)
    .sort();
}

describe("LGPD: o export alcança tudo que a redação alcança", () => {
  it("CONTROLE: as duas varreduras acham tabela (senão o teste passa medindo o vazio)", () => {
    // Sem isto, um regex que deixe de casar devolve dois conjuntos vazios e a
    // asserção abaixo fica verde — o modo de falha que este repo já pagou várias
    // vezes. E o número tem de ser plausível: a redação move mais que 3 tabelas.
    expect(tabelasDeLimpeza().length).toBeGreaterThan(3);
    expect(tabelasExportadas().length).toBeGreaterThan(3);
    expect(tabelasDeLimpeza()).toContain("conversation_drafts");
    expect(tabelasDeLimpeza()).toContain("contact_field_proposals");
  });

  it("CONTROLE: a varredura da redação enxerga a tabela que o trigger 0184 acrescentou", () => {
    // `calendar_appointments` não é redigida pelo cascade e sim por um trigger
    // separado (0184). Se a sonda só olhasse a função principal, ela sumiria — e
    // o teste passaria justamente sobre o caso que o motivou.
    expect(tabelasDeLimpeza()).toContain("calendar_appointments");
  });

  it("toda tabela que a anonimização limpa é visitada pelo export", () => {
    const exportadas = new Set(tabelasExportadas());
    const faltando = tabelasDeLimpeza().filter((t) => !exportadas.has(t));
    expect(
      faltando,
      "Estas tabelas são limpas quando o titular pede anonimização (redigidas ou " +
        "APAGADAS) e NÃO são coletadas quando ele pede acesso (Art. 18 II). O que " +
        "se apaga a pedido " +
        "dele é o que se entrega a pedido dele — acrescente o bloco em " +
        "`lib/lgpd/export-collector.ts`, espelhando o de `crm_lead_activities`:\n" +
        faltando.map((f) => `  ${f}`).join("\n"),
    ).toEqual([]);
  });
});
