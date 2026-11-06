import { describe, expect, it } from "vitest";

import { listConversationsHandler } from "@/app/api/v1/conversations/_handler";

/**
 * A BUSCA DO INBOX IGNORA ACENTO — "Andreia" acha "Andréia" e o contrário (issue #3918).
 *
 * ─── O defeito, medido na versão 1.99.0 ──────────────────────────────────────
 * A busca do inbox mandava o termo digitado para três colunas de `contacts` com
 * `ilike`:
 *
 *     or=(display_name.ilike.*Andreia*,name.ilike.*Andreia*,…)
 *
 * `ILIKE` dobra a CAIXA, não o ACENTO: `lower('Á') = 'á'`, que não é `'a'`. Quem
 * digita "Andreia" não acha "Andréia", e o contrário também não — o atendente
 * conclui que o cliente não está no CRM. No Brasil a mesma pessoa aparece escrita
 * das duas formas, e é o atendente quem digita rápido, sem acento.
 *
 * A régua do repo já conhecia esse buraco: `lib/contacts/busca-regex.ts` (#1835)
 * resolve acento no lado do TERMO para a listagem de contatos. A do inbox ficou
 * de fora, e é esta fatia.
 *
 * ─── O que este arquivo mede, e o que ele NÃO mede ───────────────────────────
 * Mede a FORMA do filtro que sai do handler: a coluna alvo é a normalizada
 * (`contacts.busca_sem_acento`, gerada por `f_unaccent` no banco) e o lado do
 * TERMO sai sem acento e em minúscula. É o par que o `ilike` sozinho não faz.
 *
 * NÃO mede o casamento no Postgres — isso é `tests/invariants/
 * busca-do-inbox-ignora-acento.test.ts`, que roda contra o banco de verdade
 * (a coluna é gerada, então a prova tem de ser do banco, não do dublê).
 *
 * O controle que impede "apague o acento de tudo, inclusive dos curingas": o
 * `%` digitado continua LITERAL (`\%`), e o termo continua filtrando. Sem esse
 * par, uma normalização que devolvesse string vazia passaria em todos os casos
 * acima — e a busca devolveria a lista inteira.
 */

interface Chamada {
  tabela: string;
  metodo: string;
  args: unknown[];
}

/** Dublê que registra a cadeia POR TABELA — o filtro nasce numa tabela, não no vazio. */
function fakeSupabase(contatos: Array<{ id: string }>) {
  const chamadas: Chamada[] = [];
  const client = {
    from: (tabela: string) => {
      const proxy: Record<string, unknown> = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "then") {
              return (ok: (v: unknown) => unknown) =>
                ok({ data: tabela === "contacts" ? contatos : [], error: null });
            }
            return (...args: unknown[]) => {
              chamadas.push({ tabela, metodo: String(prop), args });
              return proxy;
            };
          },
        },
      );
      return proxy;
    },
  };
  return { client: client as never, chamadas };
}

const ctx = {
  organization_id: "org-1",
  requestId: "req-1",
  actor: { type: "user" as const, id: "user-1" },
} as never;

/** Os argumentos que o handler mandou para `contacts.or(...)` — o filtro do nome. */
async function filtroDeContatos(search: string, contatos: Array<{ id: string }> = []) {
  const { client, chamadas } = fakeSupabase(contatos);
  await listConversationsHandler(client, ctx, { limit: 50, search } as never);
  return chamadas
    .filter((c) => c.tabela === "contacts" && c.metodo === "or")
    .flatMap((c) => c.args.map(String))
    .join(" | ");
}

async function todasAsChamadas(search: string) {
  const { client, chamadas } = fakeSupabase([{ id: "contato-x" }]);
  await listConversationsHandler(client, ctx, { limit: 50, search } as never);
  return chamadas;
}

describe("busca do inbox — o nome casa sem acento", () => {
  it("⭐ 'andreia' procura na coluna normalizada, não no nome acentuado", async () => {
    const filtro = await filtroDeContatos("andreia", [{ id: "contato-andreia" }]);

    expect(
      filtro,
      "a busca ainda mira a coluna acentuada: `ILÍKE` dobra caixa, não acento, " +
        "então 'andreia' nunca acha 'Andréia'",
    ).toContain("busca_sem_acento");
    expect(filtro, "o termo não chegou ao filtro").toContain("andreia");
    expect(
      filtro,
      "sobrou o filtro nas colunas cruas — os dois lados precisam ser normalizados",
    ).not.toContain("display_name.ilike");
  });

  it("⭐ 'Andréia' e 'andreia' produzem o MESMO filtro", async () => {
    // A simetria é o pedido da issue: quem digita com acento acha quem está sem,
    // e quem digita sem acha quem está com. Um par só de um lado resolveria
    // metade dos casos — e a issue relata as duas direções.
    const comAcento = await filtroDeContatos("Andréia");
    const semAcento = await filtroDeContatos("andreia");

    expect(comAcento, "o termo acentuado não foi normalizado").toBe(semAcento);
  });

  it("os pares do relato caem todos no mesmo lugar", async () => {
    // Os cinco pares citados na issue (#3918). Tabela, e não cinco `it`: o que se
    // prova é a REGRA, e uma regra que só vale para "Andreia" não é regra.
    const pares: Array<[digitado: string, noBanco: string]> = [
      ["Andreia", "Andréia"],
      ["Leticia", "Letícia"],
      ["Joao", "João"],
      ["Conceicao", "Conceição"],
      ["Julia", "Júlia"],
    ];

    for (const [digitado, noBanco] of pares) {
      const a = await filtroDeContatos(digitado);
      const b = await filtroDeContatos(noBanco);
      expect(a, `"${digitado}" e "${noBanco}" não caem no mesmo filtro`).toBe(b);
      expect(a, `o filtro de "${digitado}" não chegou à coluna normalizada`).toContain(
        "busca_sem_acento",
      );
    }
  });

  it("⛔ o `%` digitado continua LITERAL — não vira busca aberta", async () => {
    // Curinga injetado em busca é o defeito que `termoSeguroParaOr` documenta e
    // impede: `%` e `_` são metacaracteres do LIKE. A normalização de acento não
    // pode desfazê-lo no caminho.
    const filtro = await filtroDeContatos("%");

    expect(filtro, "o `%` deixou de ser escapado: a busca passaria a casar tudo").toContain(
      String.raw`\%`,
    );
    expect(filtro, "sobrou um `%` cru no filtro").not.toMatch(/\.\*[^\\%]*%\*/);
  });

  it("o telefone continua sendo buscado por dígitos", async () => {
    // Controle de não-regressão: a fatia troca o campo de NOME; o telefone tem
    // outro caminho (dígitos, sem acento possível) e sai daqui intacto.
    const chamadas = await todasAsChamadas("991234567");
    const texto = JSON.stringify(chamadas.filter((c) => c.tabela === "contacts"));
    expect(texto).toContain("phone_number");
  });
});
