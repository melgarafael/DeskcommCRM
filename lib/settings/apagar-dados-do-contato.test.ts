import { beforeEach, describe, expect, it } from "vitest";

import { apagarDadosDoContato } from "./apagar-dados-do-contato";

const ORG = "22222222-2222-4222-8222-222222222222";
const CONTATO = "44444444-4444-4444-8444-444444444444";

interface Delecao {
  tabela: string;
  filtros: Record<string, unknown>;
}

const delecoes: Delecao[] = [];
let contatoPermanece = false;
let tabelaQueFalha: string | null = null;
let conversas: { id: string; channel_session_id: string | null }[] = [];

/**
 * Dublê no formato do PostgREST. Acumula os filtros recebidos para o teste
 * perguntar "o filtro estava lá?", em vez de inspecionar o código-fonte.
 */
function clienteFalso() {
  return {
    from(tabela: string) {
      const filtros: Record<string, unknown> = {};
      const chain = {
        eq(coluna: string, valor: unknown) {
          filtros[coluna] = valor;
          return chain;
        },
        in(coluna: string, valores: unknown) {
          filtros[coluna] = valores;
          return chain;
        },
        select(_colunas: string) {
          return chain;
        },
        delete(_opcoes?: { count?: string }) {
          const del = {
            eq(coluna: string, valor: unknown) {
              filtros[coluna] = valor;
              return del;
            },
            in(coluna: string, valores: unknown) {
              filtros[coluna] = valores;
              return del;
            },
            then(resolve: (r: unknown) => void) {
              delecoes.push({ tabela, filtros: { ...filtros } });
              if (tabelaQueFalha === tabela) {
                resolve({ count: null, error: { message: `falhou em ${tabela}` } });
                return;
              }
              resolve({ count: 1, error: null });
            },
          };
          return del;
        },
        then(resolve: (r: unknown) => void) {
          if (tabela === "conversations") resolve({ data: conversas, error: null });
          else resolve({ data: [], error: null });
        },
        async maybeSingle() {
          if (tabela !== "contacts") return { data: null, error: null };
          return { data: contatoPermanece ? { id: CONTATO } : null, error: null };
        },
      };
      return chain;
    },
  };
}

function limpar() {
  delecoes.length = 0;
  contatoPermanece = false;
  tabelaQueFalha = null;
  conversas = [
    { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", channel_session_id: "sessao-1" },
  ];
}

beforeEach(limpar);

describe("apagarDadosDoContato — o contato nunca sai antes dos filhos RESTRICT", () => {
  it("contacts é o ÚLTIMO, e messages/conversations/calendar_appointments vêm antes", async () => {
    const r = await apagarDadosDoContato(clienteFalso() as never, {
      organizationId: ORG,
      contactId: CONTATO,
    });
    expect(r.ok).toBe(true);

    const ordem = delecoes.map((d) => d.tabela);
    const posContato = ordem.indexOf("contacts");
    expect(posContato).toBe(ordem.length - 1);
    for (const restrita of ["messages", "conversations", "calendar_appointments"]) {
      expect(ordem.indexOf(restrita)).toBeGreaterThan(-1);
      expect(ordem.indexOf(restrita)).toBeLessThan(posContato);
    }
  });

  it("apaga por contact_id e a raiz também por organization_id (service role bypassa RLS)", async () => {
    await apagarDadosDoContato(clienteFalso() as never, {
      organizationId: ORG,
      contactId: CONTATO,
    });

    const doContato = delecoes.filter((d) => d.tabela !== "contacts");
    for (const d of doContato) {
      expect(d.filtros.contact_id === CONTATO || d.filtros.conversation_id !== undefined || d.filtros.channel_session_id !== undefined).toBe(true);
    }
    const raiz = delecoes.find((d) => d.tabela === "contacts");
    expect(raiz?.filtros).toMatchObject({ id: CONTATO, organization_id: ORG });
  });

  it("não toca nas tabelas que a feature promete PRESERVAR", async () => {
    await apagarDadosDoContato(clienteFalso() as never, {
      organizationId: ORG,
      contactId: CONTATO,
    });
    const apagadas = new Set(delecoes.map((d) => d.tabela));
    for (const preservada of [
      "lgpd_requests",
      "api_audit_log",
      "organizations",
      "ai_agents",
      "channel_sessions",
      "contacts_merge_log",
    ]) {
      expect(apagadas.has(preservada)).toBe(false);
    }
  });

  it("resíduos por sessão usam os ids de conversa do contato", async () => {
    await apagarDadosDoContato(clienteFalso() as never, {
      organizationId: ORG,
      contactId: CONTATO,
    });
    const pacing = delecoes.find((d) => d.tabela === "pacing_ledger");
    expect(pacing?.filtros.channel_session_id).toEqual(["sessao-1"]);
  });

  it("resíduos por conversa usam o id da conversa carregada", async () => {
    await apagarDadosDoContato(clienteFalso() as never, {
      organizationId: ORG,
      contactId: CONTATO,
    });
    const invoc = delecoes.find((d) => d.tabela === "ai_invocations");
    expect(invoc?.filtros.conversation_id).toEqual([
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ]);
  });
});

describe("apagarDadosDoContato — a prova final", () => {
  it("contato que sobra → ok:false", async () => {
    contatoPermanece = true;
    const r = await apagarDadosDoContato(clienteFalso() as never, {
      organizationId: ORG,
      contactId: CONTATO,
    });
    expect(r.ok).toBe(false);
  });

  it("falha em uma tabela vira `falhas` e derruba o ok", async () => {
    tabelaQueFalha = "job_queue";
    const r = await apagarDadosDoContato(clienteFalso() as never, {
      organizationId: ORG,
      contactId: CONTATO,
    });
    expect(r.ok).toBe(false);
    expect(r.falhas.map((f) => f.tabela)).toContain("job_queue");
  });
});
