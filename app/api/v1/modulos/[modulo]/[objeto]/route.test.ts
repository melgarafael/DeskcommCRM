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
  /** Quando devolve erro, é a CONTAGEM que falhou (não a lista). */
  erroNaContagem: vi.fn<() => { code: string; message: string } | null>(() => null),
  /** As organizações pedidas na CONTAGEM, separadas das da lista. */
  orgsNaContagem: [] as unknown[],
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
            contagem.limit = vi.fn(() => contagem);
            contagem.eq = vi.fn((coluna: string, valor: unknown) => {
              if (coluna === "organization_id") mocks.orgsNaContagem.push(valor);
              return contagem;
            });
            contagem.then = (r: (v: unknown) => unknown) => {
              const erro = mocks.erroNaContagem();
              if (erro) return r({ count: null, error: erro });
              return r({ count: mocks.semFichasNaOrg() ? 0 : 1, error: null });
            };
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
  mocks.erroNaContagem.mockReturnValue(null);
  mocks.orgsNaContagem.length = 0;
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
   * AS DUAS RECUSAS SÃO INDISTINGUÍVEIS: "não instalado" e "a sua empresa não tem ficha".
   *
   * É contrato, não sigilo — a existência de um módulo instalado é informação da INSTALAÇÃO por
   * desenho (ADR-0002 D3), e `GET /api/v1/extensions` já a lista para qualquer `viewer`. O que a
   * simetria compra é um caso a menos para quem consome e um estado a menos na tela, em vez de um
   * 200 com `rotulo` e lista vazia.
   *
   * O caso compara código E mensagem, não só o status: diferença em qualquer um dos dois quebra a
   * simetria sem mudar o número.
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
    // Mesmo código E mesma mensagem — status igual com mensagem diferente não é simetria.
    expect(corpo.error?.code).toBe(corpoNaoInstalado.error?.code);
    expect(corpo.error?.message).toBe(corpoNaoInstalado.error?.message);
  });

  /**
   * As DUAS guardas de dentro de `semFicha()`, cada uma com o seu caso. Um cético mostrou que sem
   * eles a sabotagem passava verde 6/6: tirar o `.eq("organization_id", …)` DA CONTAGEM e trocar
   * `if (error) return true` por `false` não reprovavam nada. Guarda sem caso que a vigie é guarda
   * que o próximo refactor apaga.
   */
  it("⭐ a CONTAGEM é feita com a organização da SESSÃO — sem isso ela conta as de todo mundo", async () => {
    mocks.select.mockReturnValue(consulta([{ id: "f1" }]));
    await chamar("https://x/api/v1/modulos/odontograma/marcacao", {
      modulo: "odontograma",
      objeto: "marcacao",
    });
    // Sem o filtro, a contagem acha linha de OUTRA empresa e a rota responde 200 para quem não
    // tem nada — o recorte morre em silêncio, com todos os outros casos verdes.
    expect(mocks.orgsNaContagem).toEqual([ORG]);
  });

  it("⭐ contagem que FALHA responde 404, não 200 — na dúvida o módulo não existe aqui", async () => {
    mocks.erroNaContagem.mockReturnValue({ code: "42P01", message: "sem tabela" });
    const r = await chamar("https://x/api/v1/modulos/odontograma/marcacao", {
      modulo: "odontograma",
      objeto: "marcacao",
    });
    // `if (error) return true` é falha FECHADA. Trocar por `false` abriria a leitura justamente
    // quando o servidor não sabe o que responder.
    expect(r.status).toBe(404);
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
