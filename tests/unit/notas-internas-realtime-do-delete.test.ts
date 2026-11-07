/**
 * O CANAL DA NOTA INTERNA RECEBE O EVENTO — INCLUSIVE O DE APAGAR (#1863, F1).
 *
 * ## O que já estava consertado, e o que faltava
 *
 * A `0478` pôs `conversation_notes` na publicação `supabase_realtime`: antes
 * dela o canal subia, respondia `SUBSCRIBED` e nenhum evento chegava — a nota
 * só aparecia para os outros quando alguém recarregava a página. Isso está no
 * `baseline.sql` (o bloco "notas internas: realtime + visibilidade herdada da
 * conversa") e vigiado por `tests/unit/realtime-assinatura-tem-publicacao.test.ts`.
 *
 * O que sobrou é o OUTRO lado do mesmo defeito, e ele é do mesmo tipo: com
 * `replica identity` de fábrica (`default`, a chave primária), o payload de um
 * DELETE carrega **só o `id`**. O canal de `hooks/inbox/useConversationNotes.ts`
 * assina `event: "*"` com `filter: conversation_id=eq.<id>` — e o Realtime
 * aplica o filtro sobre o registro que tem em mãos. Sem `conversation_id` no
 * registro antigo, o evento é DESCARTADO antes de chegar ao hook. Resultado:
 * quem apagou a nota (autor ou manager, `hooks/inbox/useDeleteNote.ts`) vê a
 * nota sumir; os outros atendentes com a conversa aberta continuam vendo a nota
 * que já não existe, até recarregar. É o sintoma da #1863 ao contrário.
 *
 * ## Por que `replica identity full` e não tirar o filtro do hook
 *
 * O filtro é o que impede o canal de uma conversa de acordar por nota de outra.
 * Tirá-lo trocaria um silêncio por ruído em toda a organização. A identidade
 * `full` faz o registro ANTIGO carregar a linha inteira — é a condição que o
 * próprio schema já declara para a agenda (`supabase/baseline.sql`, bloco da
 * `0183`: "o DELETE só traz o id, então um canal com filter por owner_user_id
 * não o recebe"). Ali não foi ligada porque não havia assinante; aqui há, e a
 * tabela é pequena (poucas notas por conversa).
 *
 * ## O que este arquivo mede
 *
 * Lê o TEXTO do `baseline.sql` — a instalação self-host aplica só ele — e
 * reproduz a regra do payload por identidade. É estático de propósito: o
 * invariante de banco (`tests/invariants/notas-internas-publicam-no-realtime.test.ts`)
 * mede o catálogo de verdade; este aqui responde em milissegundos e diz QUAL
 * cláusula falta.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const BASELINE = join(process.cwd(), "supabase", "baseline.sql");
const HOOK = join(process.cwd(), "hooks", "inbox", "useConversationNotes.ts");

type Identidade = "default" | "full" | "nothing";

/** Uma linha da nota, como ela está na tabela. */
const NOTA = {
  id: "11111111-1111-4111-8111-111111111111",
  organization_id: "22222222-2222-4222-8222-222222222222",
  conversation_id: "33333333-3333-4333-8333-333333333333",
  body: "o cliente pediu o orçamento por telefone",
  created_by_user_id: "44444444-4444-4444-8444-444444444444",
  created_by_name: "Ana",
  created_at: "2026-11-07T12:00:00.000Z",
} as const;

/**
 * A identidade que o arquivo deixa para a tabela, na ORDEM em que ele é lido.
 * Ausência de cláusula = `default` (a chave primária), que é o padrão do
 * Postgres — não `full`.
 */
function identidadeDaNota(sql: string): Identidade {
  const re =
    /alter\s+table\s+(?:public\.)?conversation_notes\s+replica\s+identity\s+(full|nothing|default)\b/gi;
  let identidade: Identidade = "default";
  for (const m of sql.matchAll(re)) {
    const palavra = m[1]!.toLowerCase();
    identidade = palavra === "full" ? "full" : palavra === "nothing" ? "nothing" : "default";
  }
  return identidade;
}

/**
 * O registro que o Realtime tem em mãos num DELETE. `default` = só a chave
 * primária; `full` = a linha inteira; `nothing` = nem a chave.
 */
function registroAntigo(identidade: Identidade): Record<string, string> {
  if (identidade === "full") return { ...NOTA };
  if (identidade === "nothing") return {};
  return { id: NOTA.id };
}

/** O Realtime só entrega o evento se o filtro casar com o registro disponível. */
function canalFiltradoEntregaNoDelete(
  identidade: Identidade,
  filtro: { coluna: string; valor: string },
): boolean {
  return registroAntigo(identidade)[filtro.coluna] === filtro.valor;
}

/** O filtro que o hook realmente assina — lido do arquivo, não suposto. */
function filtroDoHook(fonte: string): { coluna: string; valor: string } | null {
  const tabela = /table:\s*"conversation_notes"/.test(fonte);
  if (!tabela) return null;
  const m = /filter:\s*`([a-z_]+)=eq\.\$\{([A-Za-z_][\w.]*)\}`/.exec(fonte);
  if (!m) return null;
  return { coluna: m[1]!, valor: NOTA.conversation_id };
}

const sql = readFileSync(BASELINE, "utf8");
const hook = readFileSync(HOOK, "utf8");

describe("a nota apagada chega no canal da conversa", () => {
  it("o instrumento acha a tabela e o filtro (guarda de vacuidade)", () => {
    // Sem estas duas, as asserções abaixo passariam medindo o vácuo: um
    // `create table` renomeado ou um hook que deixou de filtrar deixariam o
    // teste verde por não haver o que medir.
    expect(sql, "tabela conversation_notes não encontrada no baseline.sql").toMatch(
      /create table if not exists conversation_notes/i,
    );
    expect(filtroDoHook(hook), "o hook não assina conversation_notes filtrando por conversa").toEqual(
      { coluna: "conversation_id", valor: NOTA.conversation_id },
    );
  });

  it("a identidade da nota é FULL — é ela que põe conversation_id no DELETE", () => {
    expect(
      identidadeDaNota(sql),
      "conversation_notes está com replica identity de fábrica (só a PK): o DELETE " +
        "chega ao Realtime sem conversation_id, o filtro não casa e o evento é " +
        "descartado. Falta `alter table public.conversation_notes replica identity full;` " +
        "no baseline e na migration.",
    ).toBe("full");
  });

  it("com a identidade do arquivo, o DELETE casa com o filtro do hook", () => {
    const filtro = filtroDoHook(hook)!;
    expect(canalFiltradoEntregaNoDelete(identidadeDaNota(sql), filtro)).toBe(true);
  });

  it("com identidade de fábrica o mesmo DELETE é descartado (controle negativo)", () => {
    // A sabotagem: o arquivo real, sem a cláusula. Se este caso passasse a
    // entregar, o de cima estaria verde por acidente — o filtro não seria a
    // razão da falha e a prova não valeria nada.
    const semClausula = sql.replace(
      /alter\s+table\s+(?:public\.)?conversation_notes\s+replica\s+identity\s+full\s*;/gi,
      "",
    );
    expect(semClausula).not.toBe(sql);
    expect(identidadeDaNota(semClausula)).toBe("default");
    expect(canalFiltradoEntregaNoDelete("default", filtroDoHook(hook)!)).toBe(false);
  });

  it("a cláusula é declarativa — reaplicar não quebra o update", () => {
    // `replica identity` não tem forma condicional em PL/pgSQL barata; a
    // cláusula é idempotente por natureza (o Postgres aceita o mesmo valor duas
    // vezes). O que NÃO pode existir é `if not exists` inventado em volta dela,
    // que não é SQL válido para este comando.
    const clausulas = [...sql.matchAll(/replica\s+identity\s+full\s*;/gi)].map((m) => m[0]);
    expect(clausulas.length).toBeGreaterThanOrEqual(0);
    expect(sql).not.toMatch(/if\s+not\s+exists[^;]*replica\s+identity/i);
  });
});
