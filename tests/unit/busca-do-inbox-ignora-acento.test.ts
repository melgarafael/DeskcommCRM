import { describe, expect, it } from "vitest";

import { listConversationsHandler } from "@/app/api/v1/conversations/_handler";
import { termoSemAcento } from "@/lib/inbox/termo-de-busca";

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
 * A régua própria da listagem de contatos (`lib/contacts/busca-regex.ts`, #1835)
 * cobria o lado do TERMO para aquelas quatro colunas. A #3918 (fatia 2) aposentou
 * essa régua: Contatos, seletor e a ferramenta do agente passaram a usar esta
 * mesma coluna gerada, e agora existe UMA regra de acento no repo.
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
    // A busca de texto deixou de ser um `or=` em `contacts` e virou RPC
    // (`fn_contatos_da_busca`, #4326): é a função que casa, do lado do banco, e
    // devolve os ids. O dublê responde como o PostgREST responde a `rpc()`.
    rpc: (fn: string, args: unknown) => {
      chamadas.push({ tabela: "rpc", metodo: fn, args: [args] });
      return Promise.resolve({
        data: contatos.map((c) => ({ contact_id: c.id })),
        error: null,
      });
    },
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

/** Os argumentos que o handler mandou para `fn_contatos_da_busca` — o filtro do nome. */
async function filtroDeContatos(search: string, contatos: Array<{ id: string }> = []) {
  const { client, chamadas } = fakeSupabase(contatos);
  await listConversationsHandler(client, ctx, { limit: 50, search } as never);
  return chamadas
    .filter((c) => c.tabela === "rpc" && c.metodo === "fn_contatos_da_busca")
    .flatMap((c) => c.args.map((a) => JSON.stringify(a)))
    .join(" | ");
}

async function todasAsChamadas(search: string) {
  const { client, chamadas } = fakeSupabase([{ id: "contato-x" }]);
  await listConversationsHandler(client, ctx, { limit: 50, search } as never);
  return chamadas;
}

/**
 * Os ARGUMENTOS da função, já decodificados.
 *
 * O teste do `%` não pode comparar texto de JSON: `JSON.stringify` escapa a
 * barra (`\%` vira `"\\%"`), e a asserção passaria a medir o escape do
 * `stringify` em vez do escape do LIKE. Aqui se lê o valor.
 */
async function argumentosDaBusca(search: string) {
  const chamadas = await todasAsChamadas(search);
  return chamadas
    .filter((c) => c.tabela === "rpc" && c.metodo === "fn_contatos_da_busca")
    .map((c) => c.args[0] as { p_termo?: string; p_digitos?: string[] });
}

describe("busca do inbox — o nome casa sem acento", () => {
  it("⭐ 'andreia' procura na coluna normalizada, não no nome acentuado", async () => {
    const filtro = await filtroDeContatos("andreia", [{ id: "contato-andreia" }]);

    // A coluna gerada passou a ser lida DENTRO da função (#4326), então o que se
    // prova aqui é o outro lado do par: o termo chega SEM ACENTO. A coluna em si
    // é provada contra o banco em `tests/invariants/busca-do-inbox-ignora-acento`.
    expect(filtro, "o termo não chegou ao filtro").toContain('"p_termo":"andreia"');
    expect(
      filtro,
      "sobrou um filtro nas colunas cruas — o handler não deve mais ler `contacts` " +
        "com `display_name.ilike`/`name.ilike` (é a varredura que a fatia tirou)",
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
      const nomeQueChegou = /"p_termo":"([^"]*)"/.exec(a)?.[1];
      expect(nomeQueChegou, `o filtro de "${digitado}" não chegou à função`).toBeDefined();
      expect(nomeQueChegou, `"${digitado}" não foi normalizado`).toBe(termoSemAcento(digitado));
    }
  });

  it("⛔ o `%` digitado continua LITERAL — não vira busca aberta", async () => {
    // Curinga injetado em busca é o defeito que `termoSeguroParaOr` documenta e
    // impede: `%` e `_` são metacaracteres do LIKE. A normalização de acento não
    // pode desfazê-lo no caminho.
    const [args] = await argumentosDaBusca("%");

    // Comparação de VALOR, não de texto de JSON: `JSON.stringify` já escapa a
    // barra (`\%` vira `"\\%"`), e a asserção passaria a medir o escape do
    // `stringify` em vez do escape do LIKE.
    expect(
      args?.p_termo,
      "o `%` deixou de ser escapado: a busca passaria a casar tudo",
    ).toBe("\\%");
  });

  it("o telefone continua sendo buscado por dígitos", async () => {
    // Controle de não-regressão: a fatia troca o campo de NOME; o telefone tem
    // outro caminho (dígitos, sem acento possível) e sai daqui intacto.
    const chamadas = await todasAsChamadas("991234567");
    const texto = JSON.stringify(chamadas.filter((c) => c.tabela === "rpc"));
    expect(texto, "o telefone deixou de ser buscado por dígitos").toContain(
      '"p_digitos":["991234567"]',
    );
  });
});
