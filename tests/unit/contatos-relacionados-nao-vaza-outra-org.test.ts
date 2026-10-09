// @vitest-environment node
/**
 * O LINK FORJADO DE OUTRA ORGANIZAÇÃO NÃO VIRA PESSOA DO NEGÓCIO (#1506 F1).
 *
 * A rota `GET /api/v1/leads/[id]/contatos-relacionados` é a primeira leitora de
 * `crm_lead_links.target_kind='contact'` que o produto já teve — o schema, a RLS,
 * a fusão e a cascata LGPD prevêem o vínculo, e ninguém lia. Três garantias da
 * aceitação da issue, cada uma com a sabotagem que a prova:
 *
 *  1. DEFESA ALÉM DA RLS. `target_id` não é FK para `contacts` (é o preço do
 *     ponteiro polimórfico), então um link do tenant A pode apontar para o id de
 *     um contato do tenant B. Aqui o dublê devolve os DOIS contatos — é
 *     exatamente o mundo em que a RLS não está no caminho — e só a checagem de
 *     `organization_id` da rota derruba o de fora. Apague aquela linha e este
 *     teste fica vermelho com 2 itens em vez de 1.
 *  2. LÁPIDE APARECE PELO VENCEDOR. `is_merged_into` é o mapa que a fusão já
 *     reponta no baseline; quem lê tem que subir a cadeia, senão a tela exibe o
 *     contato que a fusão aposentou. A cadeia é resolvida ANTES da checagem de
 *     org, então o vencedor é quem passa por ela.
 *  3. ANONIMIZADO APARECE COMO ANONIMIZADO. A cascata LGPD já redigiu nome e
 *     telefone; a rota não mente sobre o estado e devolve o flag para a tela.
 *
 * Mais o que a consulta promete: só `target_kind='contact'` E
 * `link_kind='related'` entram (os escritores existentes gravam `appointment` e
 * `conversation`), o lead de outra org é 404 e sessão ausente é 401.
 *
 * Os FILTROS do dublê são honrados, não engolidos: um `.eq()` que a rota apaga
 * muda o resultado daqui. Dublê que devolve a lista fixa guardaria a rota que
 * não filtra nada.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createClient } from "@/lib/supabase/server";
import { GET } from "@/app/api/v1/leads/[id]/contatos-relacionados/route";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => ({ idioma: "pt-BR" })),
}));

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LEAD = "11111111-1111-4111-8111-111111111111";
const LEAD_DE_LA = "99999999-9999-4999-8999-999999999999";

const MARIA = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const DE_OUTRA_ORG = "cccccccc-cccc-4ccc-8ccc-ccccccccccc2";
const LAPIDE = "cccccccc-cccc-4ccc-8ccc-ccccccccccc3";
const VENCEDORA = "cccccccc-cccc-4ccc-8ccc-ccccccccccc4";
const ANON = "cccccccc-cccc-4ccc-8ccc-ccccccccccc5";

type Linha = Record<string, unknown>;

function contato(
  id: string,
  organization_id: string,
  extra: Partial<Record<string, unknown>> = {},
): Linha {
  return {
    id,
    organization_id,
    name: null,
    display_name: null,
    is_merged_into: null,
    is_anonymized: false,
    ...extra,
  };
}

/** Um link do LEAD da org A — inclusive o forjado, que aponta para fora. */
function link(target_id: string, extra: Partial<Record<string, unknown>> = {}): Linha {
  return {
    organization_id: ORG_A,
    lead_id: LEAD,
    target_kind: "contact",
    target_id,
    link_kind: "related",
    metadata: null,
    ...extra,
  };
}

/**
 * Dublê de PostgREST que HONRA os filtros — a diferença que importa aqui.
 *
 * `eq` e `in` são registrados e aplicados; `maybeSingle` devolve a primeira
 * linha filtrada e o próprio elo é então-ável (`await`), como faz o
 * supabase-js — e resolve `{ data, error }`, NÃO a lista crua: quem lê é
 * `const { data } = await …`, e uma lista nua deixaria `data` indefinido em
 * silêncio. Sem essa disciplina, apagar `.eq("target_kind", "contact")` da
 * rota continuaria verde.
 */
function montarBanco(
  tabelas: Record<string, Linha[]>,
  sessao: { id: string } | null = { id: "usuario-1" },
) {
  const from = (nome: string) => {
    const base = tabelas[nome] ?? [];
    const eqs: [string, unknown][] = [];
    const ins: [string, unknown[]][] = [];
    let ordem: [string, boolean] | null = null;
    const elo: Record<string, unknown> = {
      select: () => elo,
      order: (coluna: string, opcoes?: { ascending?: boolean }) => {
        ordem = [coluna, opcoes?.ascending !== false];
        return elo;
      },
      eq: (coluna: string, valor: unknown) => {
        eqs.push([coluna, valor]);
        return elo;
      },
      in: (coluna: string, valores: unknown[]) => {
        ins.push([coluna, valores]);
        return elo;
      },
    };
    const linhas = () => {
      const filtradas = base.filter(
        (l) => eqs.every(([c, v]) => l[c] === v) && ins.every(([c, v]) => v.includes(l[c])),
      );
      if (!ordem) return filtradas;
      const [coluna, crescente] = ordem;
      return [...filtradas].sort(
        (a, b) => String(a[coluna]).localeCompare(String(b[coluna])) * (crescente ? 1 : -1),
      );
    };
    elo.maybeSingle = () => Promise.resolve({ data: linhas()[0] ?? null, error: null });
    elo.then = (
      aoOk?: (valor: { data: Linha[]; error: null }) => unknown,
      aoErr?: (erro: unknown) => unknown,
    ) => Promise.resolve({ data: linhas(), error: null }).then(aoOk, aoErr);
    return elo;
  };
  vi.mocked(createClient).mockResolvedValue({
    auth: {
      getUser: async () =>
        sessao
          ? { data: { user: sessao }, error: null }
          : { data: { user: null }, error: { message: "Auth session missing!" } },
    },
    from,
  } as never);
}

function chamar(id = LEAD) {
  const req = new NextRequest(`http://localhost/api/v1/leads/${id}/contatos-relacionados`);
  return GET(req, { params: Promise.resolve({ id }) });
}

async function corpo(resposta: Response) {
  return (await resposta.json()) as { data?: unknown[]; error?: { code: string } };
}

beforeEach(() => {
  vi.mocked(createClient).mockReset();
});

describe("GET contatos-relacionados — a F1 da #1506", () => {
  it("não mostra contato de outra organização num link forjado, mesmo sem RLS", async () => {
    montarBanco({
      crm_leads: [{ id: LEAD, organization_id: ORG_A }],
      crm_lead_links: [
        link(MARIA, { metadata: { papel: "Responsável financeiro" } }),
        // O forjado: linha do tenant A (ela passaria em qualquer filtro de org
        // da própria tabela) apontando para o id de um contato do tenant B.
        link(DE_OUTRA_ORG),
      ],
      // Os DOIS contatos voltam: é este mundo que a checagem da rota tem de
      // aguentar quando `target_id` não resolve dono.
      contacts: [
        contato(MARIA, ORG_A, { name: "Maria Silva" }),
        contato(DE_OUTRA_ORG, ORG_B, { name: "João de Outra Empresa" }),
      ],
    });

    const { data } = await corpo(await chamar());

    expect(data).toEqual([
      {
        contact_id: MARIA,
        nome: "Maria Silva",
        papel: "Responsável financeiro",
        anonimizado: false,
      },
    ]);
  });

  it("só lê target_kind='contact' com link_kind='related'", async () => {
    montarBanco({
      crm_leads: [{ id: LEAD, organization_id: ORG_A }],
      crm_lead_links: [
        link(MARIA, { link_kind: "appointment" }),
        link(MARIA, { target_kind: "conversation" }),
      ],
      contacts: [contato(MARIA, ORG_A, { name: "Maria Silva" })],
    });

    const { data } = await corpo(await chamar());

    expect(data).toEqual([]);
  });

  it("mostra o contato em lápide pelo vencedor da fusão", async () => {
    montarBanco({
      crm_leads: [{ id: LEAD, organization_id: ORG_A }],
      crm_lead_links: [link(LAPIDE)],
      contacts: [
        contato(LAPIDE, ORG_A, { name: "Nome antigo", is_merged_into: VENCEDORA }),
        contato(VENCEDORA, ORG_A, { name: "Maria da Silva" }),
      ],
    });

    const { data } = await corpo(await chamar());

    expect(data).toEqual([
      {
        contact_id: VENCEDORA,
        nome: "Maria da Silva",
        papel: null,
        anonimizado: false,
      },
    ]);
  });

  it("devolve contato anonimizado como anonimizado, sem fingir que não existe", async () => {
    montarBanco({
      crm_leads: [{ id: LEAD, organization_id: ORG_A }],
      crm_lead_links: [link(ANON)],
      contacts: [contato(ANON, ORG_A, { name: "Cliente Anonimizado #7", is_anonymized: true })],
    });

    const { data } = await corpo(await chamar());

    expect(data).toEqual([
      {
        contact_id: ANON,
        nome: "Cliente Anonimizado #7",
        papel: null,
        anonimizado: true,
      },
    ]);
  });

  it("não repete a mesma pessoa quando há dois links para o mesmo contato", async () => {
    montarBanco({
      crm_leads: [{ id: LEAD, organization_id: ORG_A }],
      crm_lead_links: [
        // Fora de ordem de propósito: a consulta é que ordena por created_at.
        link(MARIA, {
          metadata: { papel: "Responsável financeiro" },
          created_at: "2026-10-02T12:00:00Z",
        }),
        link(MARIA, { metadata: { papel: "Mãe" }, created_at: "2026-10-01T12:00:00Z" }),
      ],
      contacts: [contato(MARIA, ORG_A, { name: "Maria Silva" })],
    });

    const { data } = await corpo(await chamar());

    expect(data).toHaveLength(1);
    // O link MAIS ANTIGO vence: a rota ordena os links por created_at.
    expect(data?.[0]).toMatchObject({ papel: "Mãe" });
  });

  it("devolve 404 para lead que o caller não enxerga (a org prova o acesso)", async () => {
    montarBanco({
      crm_leads: [{ id: LEAD_DE_LA, organization_id: ORG_B }],
      crm_lead_links: [],
      contacts: [],
    });

    const resposta = await chamar(LEAD);

    expect(resposta.status).toBe(404);
    expect((await corpo(resposta)).error?.code).toBe("not_found");
  });

  it("devolve 401 sem sessão", async () => {
    montarBanco({}, null);

    const resposta = await chamar();

    expect(resposta.status).toBe(401);
    expect((await corpo(resposta)).error?.code).toBe("unauthenticated");
  });
});
