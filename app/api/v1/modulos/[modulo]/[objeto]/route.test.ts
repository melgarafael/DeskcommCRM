import { describe, expect, it, vi, beforeEach } from "vitest";

import type { ActiveOrg } from "@/lib/auth/types";

/**
 * A LEITURA das fichas de um módulo de dados, pelo caminho HTTP.
 *
 * Três propriedades que não podem depender de revisão de olho:
 *
 * 1. **A organização vem da SESSÃO, nunca do pedido.** É a regra do CLAUDE.md para todo handler que
 *    usa a chave de serviço, e aqui ela é dupla: a tabela do módulo é server-only, então o filtro por
 *    organização existe só no código — não há RLS de navegador para salvar um esquecimento.
 * 2. **O nome da tabela não vem da URL.** `modulo` e `objeto` chegam do endereço; se virassem nome de
 *    tabela por concatenação, qualquer pessoa autenticada leria qualquer tabela do banco. O nome é
 *    resolvido a partir do que está INSTALADO, e o que não casa é 404.
 * 3. **Quem não é membro não lê.** O gate é o mesmo `requireRole` do resto de `/api/v1`.
 */

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  tabelaDoObjeto: vi.fn(),
  select: vi.fn(),
  /** A contagem de existência por organização: `true` = a empresa não tem ficha nenhuma. */
  semFichasNaOrg: vi.fn(() => false),
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: mocks.requireRole }));
vi.mock("@/lib/modulos/dados/tabela", () => ({ tabelaDoObjeto: mocks.tabelaDoObjeto }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      /**
       * A rota faz DUAS leituras na mesma tabela: a CONTAGEM de existência por organização
       * (`select("id", { count: "exact", head: true })`) e a LISTA de fichas.
       *
       * O dublê as distingue pela SEMÂNTICA — `head: true` — e não por ordem de chamada. A
       * primeira versão contava chamadas (`mock.calls.length === 0`) e se autossabotava, porque
       * consultar o contador já o incrementava; dois casos que deviam dar 200 davam 404. Dublê que
       * depende de ordem mede a ordem, não o comportamento.
       */
      return {
        select: (colunas: string, opcoes?: { head?: boolean }) => {
          if (opcoes?.head) {
            const contagem: Record<string, unknown> = {};
            for (const m of ["eq", "limit"]) contagem[m] = vi.fn(() => contagem);
            contagem.then = (r: (v: unknown) => unknown) =>
              r({ count: mocks.semFichasNaOrg() ? 0 : 1, error: null });
            return contagem;
          }
          const lista = mocks.select() as { select: (c: string) => unknown };
          return lista.select(colunas);
        },
      };
    },
  }),
}));

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const CONTATO = "bbbbbbbb-0000-4000-8000-000000000002";

/** Encadeamento mínimo do client: `.select().eq().eq().order().limit()`. */
function consulta(linhas: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order", "limit"]) chain[m] = vi.fn(() => chain);
  chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: linhas, error: null });
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
  // ⚠️ TIPADO de propósito. A primeira versão deste mock devolvia `{ organization_id: ORG }`, um
  // campo que `ActiveOrg` NÃO tem — o campo é `orgId`. O teste passava, porque o mock inventava a
  // forma do dado, e a rota filtrava por `undefined`: o isolamento entre organizações teria ido para
  // produção quebrado, com quatro casos verdes em cima. Quem pegou foi o `tsc` do CI.
  //
  // Com a anotação, inventar campo não compila mais.
  const org: ActiveOrg = { orgId: ORG, role: "viewer" } as ActiveOrg;
  mocks.requireRole.mockResolvedValue({ ok: true, org, user: { id: "u1" } });
  mocks.semFichasNaOrg.mockReturnValue(false);
  mocks.tabelaDoObjeto.mockResolvedValue({
    tabela: "m_clinica_odontograma_marcacao",
    campos: [{ slug: "dente", tipo: "inteiro" }],
    refDoContato: "paciente_id",
  });
});

async function chamar(url: string, params: { modulo: string; objeto: string }) {
  const { GET } = await import("./route");
  return GET(new Request(url), { params: Promise.resolve(params) });
}

describe("GET /api/v1/modulos/[modulo]/[objeto]", () => {
  it("filtra pela organização da SESSÃO, e ignora qualquer organização pedida na URL", async () => {
    const chain = consulta([{ id: "f1", dente: 11 }]);
    mocks.select.mockReturnValue(chain);

    const outraOrg = "cccccccc-0000-4000-8000-000000000003";
    const r = await chamar(
      `https://x/api/v1/modulos/odontograma/marcacao?contato=${CONTATO}&organization_id=${outraOrg}`,
      { modulo: "odontograma", objeto: "marcacao" },
    );

    expect(r.status).toBe(200);
    const orgsFiltradas = (chain.eq as ReturnType<typeof vi.fn>).mock.calls
      .filter((c) => c[0] === "organization_id")
      .map((c) => c[1]);
    expect(orgsFiltradas).toEqual([ORG]);
    expect(orgsFiltradas).not.toContain(outraOrg);
  });

  it("objeto que não está instalado é 404, e nenhuma consulta sai", async () => {
    mocks.tabelaDoObjeto.mockResolvedValue(null);
    const r = await chamar("https://x/api/v1/modulos/qualquer/coisa", {
      modulo: "qualquer",
      objeto: "coisa",
    });
    expect(r.status).toBe(404);
    expect(mocks.select).not.toHaveBeenCalled();
  });

  /**
   * ⚠️ A ROTA NÃO PODE VIRAR ORÁCULO DE "QUAIS MÓDULOS EXISTEM NESTA INSTALAÇÃO".
   *
   * Ela respondia 200 com `rotulo` e `campos` mesmo quando a empresa não tem nenhuma ficha, e o
   * 404 só existia para módulo NÃO INSTALADO. Quem quisesse descobrir os módulos usados pelas
   * outras empresas do mesmo servidor só precisava comparar as duas respostas.
   *
   * A régua: as duas situações respondem o MESMO 404, indistinguível. Quem tem ficha lê; para
   * todo o resto, o módulo não existe.
   */
  it("⭐ empresa SEM nenhuma ficha recebe o MESMO 404 de módulo não instalado", async () => {
    mocks.semFichasNaOrg.mockReturnValue(true);
    const r = await chamar("https://x/api/v1/modulos/odontograma/marcacao", {
      modulo: "odontograma",
      objeto: "marcacao",
    });
    const corpo = (await r.json()) as { error?: { code?: string; message?: string } };

    mocks.tabelaDoObjeto.mockResolvedValue(null);
    const naoInstalado = await chamar("https://x/api/v1/modulos/qualquer/coisa", {
      modulo: "qualquer",
      objeto: "coisa",
    });
    const corpoNaoInstalado = (await naoInstalado.json()) as {
      error?: { code?: string; message?: string };
    };

    expect(r.status).toBe(404);
    expect(naoInstalado.status).toBe(404);
    // Indistinguíveis: mesmo código E mesma mensagem. Qualquer diferença aqui é o oráculo de volta.
    expect(corpo.error?.code).toBe(corpoNaoInstalado.error?.code);
    expect(corpo.error?.message).toBe(corpoNaoInstalado.error?.message);
  });

  it("empresa COM ficha continua lendo — senão o caso de cima seria vacuidade", async () => {
    mocks.semFichasNaOrg.mockReturnValue(false);
    mocks.select.mockReturnValue(consulta([{ id: "f1", dente: 11 }]));
    const r = await chamar("https://x/api/v1/modulos/odontograma/marcacao", {
      modulo: "odontograma",
      objeto: "marcacao",
    });
    expect(r.status).toBe(200);
  });

  it("quem não passa no gate de papel recebe a recusa dele, sem consultar nada", async () => {
    mocks.requireRole.mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 403 }),
    });
    const r = await chamar("https://x/api/v1/modulos/odontograma/marcacao", {
      modulo: "odontograma",
      objeto: "marcacao",
    });
    expect(r.status).toBe(403);
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it("o contato pedido precisa ser um uuid — texto livre não chega à consulta", async () => {
    mocks.select.mockReturnValue(consulta([]));
    const r = await chamar("https://x/api/v1/modulos/odontograma/marcacao?contato=; drop table", {
      modulo: "odontograma",
      objeto: "marcacao",
    });
    expect(r.status).toBe(400);
  });
});
