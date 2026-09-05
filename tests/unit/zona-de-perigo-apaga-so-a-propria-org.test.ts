/**
 * ZONA DE PERIGO (Configurações › Organização) — o reset de dados de teste.
 *
 * Esta action é a única do produto que apaga dado de cliente em massa, e ela
 * usa o client de SERVICE ROLE, que bypassa RLS. Isso inverte quem protege o
 * vizinho: não é mais o Postgres, é o `.eq("organization_id", …)` de cada
 * DELETE. Um `.eq` esquecido não devolve erro, não fica vermelho em lugar
 * nenhum, e esvazia o banco INTEIRO — todas as organizações da instalação.
 *
 * Por isso o teste não pergunta "a action funciona?". Ele pergunta três coisas
 * que só falham em produção:
 *
 *   1. **Todo** DELETE carrega o filtro de organização, e o valor do filtro é
 *      o da SESSÃO — nunca o que veio no input. A varredura é sobre as
 *      chamadas realmente emitidas, não sobre uma lista escrita à mão: tabela
 *      nova acrescentada em `RAIZES_DO_APAGAMENTO` entra na conta sozinha.
 *   2. A ORDEM respeita as três FKs `ON DELETE RESTRICT` para `contacts`
 *      (`messages`, `conversations`, `calendar_appointments`). Errar a ordem
 *      não é estética: o Postgres devolve 23503 e o reset para no meio.
 *   3. Quem não é admin, e quem digitou o nome errado, não emite DELETE nenhum
 *      — e a conferência do nome é feita contra o `display_name` LIDO DO BANCO,
 *      porque uma server action é endpoint público e o diálogo do navegador
 *      não é gate de nada.
 *
 * O que este arquivo NÃO prova: que o filtro funciona no Postgres de verdade.
 * Isso é `tests/e2e/zona-de-perigo-apaga-dados-de-teste.spec.ts`, que apaga a
 * organização A pela TELA e confere no banco que a B ficou inteira.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RAIZES_DO_APAGAMENTO } from "@/lib/settings/apagar-dados-operacionais";

const ORG = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG = "33333333-3333-4333-8333-333333333333";
const USER = "11111111-1111-4111-8111-111111111111";
const NOME_DA_ORG = "Clínica Bem Viver";

interface Delecao {
  tabela: string;
  filtros: Record<string, unknown>;
}

const delecoes: Delecao[] = [];
const auditadas: Array<Record<string, unknown>> = [];

let papel = "admin";
let ehPlatformAdmin = false;
let mfaPendente = false;
let nomeNoBanco: string | null = NOME_DA_ORG;
/** Quando setado, o DELETE nesta tabela devolve erro — simula a parada no meio. */
let tabelaQueFalha: string | null = null;
/** Quantas linhas cada DELETE afirma ter apagado. */
const linhasPorTabela: Record<string, number> = {};

vi.mock("next/headers", () => ({
  headers: async () => new Map<string, string>([["x-request-id", "req-teste"]]),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async (e: Record<string, unknown>) => {
    auditadas.push(e);
  }),
}));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => ({ id: USER, is_platform_admin: ehPlatformAdmin })),
  resolveActiveOrg: vi.fn(async () => ({ orgId: ORG, name: NOME_DA_ORG, role: papel })),
  mfaEmDivida: vi.fn(async () => mfaPendente),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => clienteFalso() }));

/**
 * Dublê no formato do PostgREST. `delete()` e `select()` são thenables que
 * acumulam os `.eq()` recebidos — é essa acumulação, e não uma inspeção do
 * código-fonte, que responde "o filtro estava lá?".
 */
function clienteFalso() {
  return {
    from(tabela: string) {
      const filtros: Record<string, unknown> = {};
      const construtor = {
        eq(coluna: string, valor: unknown) {
          filtros[coluna] = valor;
          return construtor;
        },
        delete(_opcoes?: { count?: string }) {
          const alvo = {
            eq(coluna: string, valor: unknown) {
              filtros[coluna] = valor;
              return alvo;
            },
            then(resolve: (r: unknown) => void) {
              delecoes.push({ tabela, filtros: { ...filtros } });
              if (tabelaQueFalha === tabela) {
                resolve({ count: null, error: { code: "23503", message: `falhou em ${tabela}` } });
                return;
              }
              resolve({ count: linhasPorTabela[tabela] ?? 0, error: null });
            },
          };
          return alvo;
        },
        select(_colunas: string) {
          return construtor;
        },
        async maybeSingle() {
          if (tabela !== "organizations") return { data: null, error: null };
          if (filtros.id !== ORG) return { data: null, error: null };
          return {
            data: nomeNoBanco === null ? null : { display_name: nomeNoBanco },
            error: null,
          };
        },
      };
      return construtor;
    },
  };
}

import { apagarDadosOperacionaisDaOrganizacao } from "@/app/actions/settings/apagarDadosOperacionaisDaOrganizacao";

beforeEach(() => {
  delecoes.length = 0;
  auditadas.length = 0;
  papel = "admin";
  ehPlatformAdmin = false;
  mfaPendente = false;
  nomeNoBanco = NOME_DA_ORG;
  tabelaQueFalha = null;
  for (const k of Object.keys(linhasPorTabela)) delete linhasPorTabela[k];
});

describe("zona de perigo: o apagamento não sai da própria organização", () => {
  it("todo DELETE emitido carrega organization_id = o da SESSÃO", async () => {
    const r = await apagarDadosOperacionaisDaOrganizacao({ confirmNome: NOME_DA_ORG });

    expect(r.ok).toBe(true);
    // Sanidade da sonda: um `expect` sobre uma lista vazia passaria calado.
    expect(delecoes.length).toBe(RAIZES_DO_APAGAMENTO.length);
    expect(delecoes.length).toBeGreaterThan(0);

    const semFiltro = delecoes.filter((d) => d.filtros.organization_id !== ORG);
    expect(semFiltro.map((d) => d.tabela)).toEqual([]);
  });

  it("nenhum DELETE usa outra organização, nem mesmo por engano de variável", async () => {
    await apagarDadosOperacionaisDaOrganizacao({ confirmNome: NOME_DA_ORG });
    for (const d of delecoes) {
      expect(d.filtros.organization_id).not.toBe(OUTRA_ORG);
      expect(d.filtros.organization_id).toBeTruthy();
    }
  });

  it("apaga exatamente as seis raízes declaradas — nem tabela a mais, nem a menos", async () => {
    await apagarDadosOperacionaisDaOrganizacao({ confirmNome: NOME_DA_ORG });
    expect(delecoes.map((d) => d.tabela)).toEqual([
      "messages",
      "conversations",
      "calendar_appointments",
      "orders",
      "crm_leads",
      "contacts",
    ]);
  });

  it("contacts sai por último: as três FKs RESTRICT vêm antes dele", async () => {
    await apagarDadosOperacionaisDaOrganizacao({ confirmNome: NOME_DA_ORG });
    const ordem = delecoes.map((d) => d.tabela);
    const posContacts = ordem.indexOf("contacts");
    expect(posContacts).toBeGreaterThan(-1);
    for (const restrita of ["messages", "conversations", "calendar_appointments"]) {
      expect(ordem.indexOf(restrita)).toBeGreaterThan(-1);
      expect(ordem.indexOf(restrita)).toBeLessThan(posContacts);
    }
  });

  it("nenhuma tabela que a feature promete PRESERVAR aparece no apagamento", async () => {
    await apagarDadosOperacionaisDaOrganizacao({ confirmNome: NOME_DA_ORG });
    const apagadas = new Set(delecoes.map((d) => d.tabela));
    for (const preservada of [
      "organizations",
      "user_organizations",
      "crm_pipelines",
      "crm_stages",
      "ai_agents",
      "ai_provider_credentials",
      "channel_sessions",
      "api_tokens",
      "api_audit_log",
      "lgpd_requests",
    ]) {
      expect(apagadas.has(preservada)).toBe(false);
    }
  });
});

describe("zona de perigo: quem pode puxar o gatilho", () => {
  for (const papelSemPoder of ["agent", "viewer", "manager"]) {
    it(`${papelSemPoder} recebe forbidden_role e não emite DELETE nenhum`, async () => {
      papel = papelSemPoder;
      const r = await apagarDadosOperacionaisDaOrganizacao({ confirmNome: NOME_DA_ORG });
      expect(r).toEqual({ ok: false, error: "forbidden_role" });
      expect(delecoes).toEqual([]);
      expect(auditadas).toEqual([]);
    });
  }

  it("sessão com fator de MFA pendente não apaga nada", async () => {
    mfaPendente = true;
    const r = await apagarDadosOperacionaisDaOrganizacao({ confirmNome: NOME_DA_ORG });
    expect(r).toEqual({ ok: false, error: "mfa_required" });
    expect(delecoes).toEqual([]);
  });

  it("platform admin passa mesmo sem papel de admin no tenant", async () => {
    papel = "viewer";
    ehPlatformAdmin = true;
    const r = await apagarDadosOperacionaisDaOrganizacao({ confirmNome: NOME_DA_ORG });
    expect(r.ok).toBe(true);
    expect(delecoes.length).toBe(RAIZES_DO_APAGAMENTO.length);
  });
});

describe("zona de perigo: a confirmação é conferida no SERVIDOR", () => {
  it("nome errado não apaga nada, mesmo com papel de admin", async () => {
    const r = await apagarDadosOperacionaisDaOrganizacao({ confirmNome: "Clinica Bem Viver" });
    expect(r).toEqual({ ok: false, error: "confirmacao_nao_confere" });
    expect(delecoes).toEqual([]);
  });

  it("string vazia é recusada antes de tocar no banco", async () => {
    const r = await apagarDadosOperacionaisDaOrganizacao({ confirmNome: "   " });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("confirmacao_nao_confere");
    expect(delecoes).toEqual([]);
  });

  it("o nome conferido é o do BANCO — trocá-lo lá derruba a confirmação antiga", async () => {
    nomeNoBanco = "Outro Nome Ltda";
    const r = await apagarDadosOperacionaisDaOrganizacao({ confirmNome: NOME_DA_ORG });
    expect(r).toEqual({ ok: false, error: "confirmacao_nao_confere" });
    expect(delecoes).toEqual([]);

    const certo = await apagarDadosOperacionaisDaOrganizacao({ confirmNome: "Outro Nome Ltda" });
    expect(certo.ok).toBe(true);
  });
});

describe("zona de perigo: o apagamento deixa rastro", () => {
  it("audita org.dados_operacionais_apagados com as contagens", async () => {
    linhasPorTabela.messages = 12;
    linhasPorTabela.contacts = 3;
    const r = await apagarDadosOperacionaisDaOrganizacao({ confirmNome: NOME_DA_ORG });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.counts).toMatchObject({ messages: 12, contacts: 3 });
    expect(auditadas.length).toBe(1);
    expect(auditadas[0]).toMatchObject({
      action: "org.dados_operacionais_apagados",
      organizationId: ORG,
      actorUserId: USER,
      bypassedRls: true,
    });
    expect((auditadas[0]!.metadata as { counts: Record<string, number> }).counts.messages).toBe(12);
  });

  it("parada no meio audita o que JÁ foi apagado — não some com a contagem parcial", async () => {
    linhasPorTabela.messages = 7;
    linhasPorTabela.conversations = 2;
    tabelaQueFalha = "crm_leads";

    const r = await apagarDadosOperacionaisDaOrganizacao({ confirmNome: NOME_DA_ORG });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("db_error");
    // `contacts` vem depois de `crm_leads`: a parada precisa ser antes dele,
    // senão o teste não estaria exercitando parada nenhuma.
    expect(delecoes.map((d) => d.tabela)).not.toContain("contacts");
    expect(auditadas.length).toBe(1);
    const meta = auditadas[0]!.metadata as { counts: Record<string, number>; falhou_em?: string };
    expect(meta.counts.messages).toBe(7);
    expect(meta.falhou_em).toBe("crm_leads");
  });
});
