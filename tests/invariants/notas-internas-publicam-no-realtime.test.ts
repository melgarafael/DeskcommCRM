import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

/**
 * A NOTA INTERNA PUBLICA — E O DELETE DELA CHEGA NO CANAL FILTRADO (#1863, F1).
 *
 * Duas condições, e as duas são necessárias: a tabela estar na publicação
 * `supabase_realtime` (0478) e o registro antigo carregar a linha inteira, senão
 * o `filter: conversation_id=eq.<id>` de `hooks/inbox/useConversationNotes.ts:43`
 * não casa no DELETE (9247). As duas falham do mesmo jeito: o canal responde
 * `SUBSCRIBED` e a tela simplesmente não muda — sem erro em lugar nenhum.
 *
 * A primeira asserção existe para a segunda não medir o vácuo: publicação
 * inexistente devolveria lista vazia e, num catálogo sem `conversation_notes`,
 * `relreplident` voltaria nulo com o teste passando por ausência de dado.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db`");
const containerName: string = container;

function psql(sql: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-tA", "-c", sql],
    { encoding: "utf8" },
  ).trim();
}

function publicadas(): string[] {
  return psql(
    "select tablename from pg_publication_tables " +
      "where pubname='supabase_realtime' and schemaname='public' order by 1",
  )
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** `f` = full; `d` = default (só a chave primária). */
function identidadeDaTabela(tabela: string): string {
  return psql(`select relreplident from pg_class where oid = 'public.${tabela}'::regclass`);
}

describe("a nota interna no realtime", () => {
  it("a sonda enxerga a publicação e a tabela (guarda de vacuidade)", () => {
    expect(publicadas().length).toBeGreaterThan(5);
    expect(psql("select to_regclass('public.conversation_notes') is not null")).toBe("t");
  });

  it("conversation_notes PUBLICA — o INSERT do colega tem por onde chegar", () => {
    expect(publicadas()).toContain("conversation_notes");
  });

  it("conversation_notes tem replica identity FULL — o DELETE traz conversation_id", () => {
    expect(
      identidadeDaTabela("conversation_notes"),
      "replica identity de fábrica (d): o payload do DELETE só tem a chave primária, o " +
        "filtro por conversation_id não casa e a nota apagada fica na tela dos outros " +
        "até o F5. A migration 9247 liga `replica identity full`.",
    ).toBe("f");
  });

  it("a telemetria continua fora da publicação (o gate não foi afrouxado)", () => {
    // Controle negativo: se alguém "consertasse" publicando o schema inteiro,
    // este caso reprova — `crm_lead_scores` é recálculo, não mudança de estado
    // que deva pintar card (bloco da 9046).
    expect(publicadas()).not.toContain("crm_lead_scores");
  });
});
