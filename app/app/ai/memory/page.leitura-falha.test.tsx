/**
 * #4171 — "NÃO CONSEGUI LER" NÃO É "NÃO EXISTE NADA".
 *
 * A tela de Memória da IA fazia quatro leituras na página e descartava o
 * `error` de todas: com o banco fora do ar, o selo dizia "Nenhuma versão
 * publicada ainda" e os aprendizados diziam "Nenhum aprendizado ainda" —
 * exatamente o que a tela mostra quando não há nada publicado. Quem tinha
 * memória publicada (e via os agentes usando) concluía que a tela estava vazia
 * por defeito, e o defeito é o contrário: era a LEITURA que falhava.
 *
 * Este arquivo monta a página inteira, com o banco mockado, e prova os DOIS
 * ramos, um ao lado do outro:
 *
 *   leitura falha      → aviso próprio + "Tentar de novo"; nenhum texto de vazio
 *   leitura ok e vazia → o texto de vazio de sempre, e nenhum aviso de falha
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "11111111-1111-4111-8111-111111111111";

/**
 * O que cada leitura do banco devolve. `erroEm` é o defeito: a tabela responde
 * com erro (PostgREST indisponível, RLS, timeout), que é diferente de responder
 * "não há linha".
 */
const banco = vi.hoisted(() => ({
  erroEm: {
    ponteiros: false,
    versaoAtiva: false,
    versoes: false,
    aprendizados: false,
  },
  /** Instalação nova: o ponteiro responde "não há linha". */
  temPonteiro: true,
  conteudo: "Sempre confirme o prazo de entrega antes de prometer.",
  versoes: [] as Array<Record<string, unknown>>,
  aprendizados: [] as Array<Record<string, unknown>>,
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
// Por padrão a releitura do cliente fica pendente (ver o `beforeEach`): o teste
// mede o estado que a PÁGINA entregou. Os casos de releitura trocam a resposta.
const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/api/client", () => ({
  apiClient: { get: api.get, post: vi.fn(), patch: vi.fn() },
}));
vi.mock("@/hooks/auth/AuthProvider", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  usePermission: () => true,
}));
vi.mock("@/app/actions/settings/definirLimiteDoPesoDaMemoria", () => ({
  definirLimiteDoPesoDaMemoria: vi.fn(),
}));
vi.mock("@/lib/auth/server", () => ({
  requireAuth: vi.fn(async () => ({
    id: "actor",
    idioma: "pt-BR",
    is_platform_admin: false,
    support: null,
  })),
  resolveActiveOrg: vi.fn(async () => ({
    orgId: ORG,
    role: "admin",
    timezone: "America/Sao_Paulo",
  })),
}));

const ERRO_DO_BANCO = { message: "canceling statement due to statement timeout", code: "57014" };

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (tabela: string) => {
      const cadeia: Record<string, unknown> = {
        maybeSingle: async () => {
          if (tabela === "org_memory_pointers") {
            if (banco.erroEm.ponteiros) return { data: null, error: ERRO_DO_BANCO };
            return banco.temPonteiro
              ? { data: { version_id: "v1" }, error: null }
              : { data: null, error: null };
          }
          if (tabela === "org_memory_versions") {
            return banco.erroEm.versaoAtiva
              ? { data: null, error: ERRO_DO_BANCO }
              : {
                  data: {
                    id: "v1",
                    version_number: 3,
                    content: banco.conteudo,
                    created_at: "2026-10-01T00:00:00Z",
                  },
                  error: null,
                };
          }
          if (tabela === "organizations") return { data: { settings: {} }, error: null };
          return { data: null, error: null };
        },
        then: (ok: (v: unknown) => unknown, erro: (e: unknown) => unknown) => {
          if (tabela === "org_memory_entries") {
            return Promise.resolve(
              banco.erroEm.aprendizados
                ? { data: null, error: ERRO_DO_BANCO }
                : { data: banco.aprendizados, error: null },
            ).then(ok, erro);
          }
          if (tabela === "org_memory_versions") {
            return Promise.resolve(
              banco.erroEm.versoes ? { data: null, error: ERRO_DO_BANCO } : { data: banco.versoes, error: null },
            ).then(ok, erro);
          }
          return Promise.resolve({ data: [], error: null }).then(ok, erro);
        },
      };
      for (const m of ["select", "eq", "neq", "order"]) cadeia[m] = () => cadeia;
      return cadeia;
    },
  }),
}));

import OrgMemoryPage from "@/app/app/ai/memory/page";

async function abrir() {
  const pagina = await OrgMemoryPage();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}>{pagina}</QueryClientProvider>);
}

const VAZIO_DE_VERDADE = "Nenhuma versão publicada ainda";
const AVISO_DE_FALHA = "Não consegui ler a memória agora";
const APRENDIZADO_DE_VERDADE = /Nenhum aprendizado ainda/;

beforeEach(() => {
  api.get.mockReset();
  api.get.mockImplementation(() => new Promise(() => {}));
  banco.erroEm = { ponteiros: false, versaoAtiva: false, versoes: false, aprendizados: false };
  banco.temPonteiro = true;
  banco.conteudo = "Sempre confirme o prazo de entrega antes de prometer.";
  banco.versoes = [{ id: "v1", version_number: 3, created_at: "2026-10-01T00:00:00Z" }];
  banco.aprendizados = [];
});
afterEach(cleanup);

describe("leitura que falha não pode ter a cara de memória vazia", () => {
  it("ponteiro ilegível: não diz 'nenhuma versão publicada', diz que não conseguiu ler", async () => {
    banco.erroEm.ponteiros = true;

    await abrir();

    expect(screen.queryByText(VAZIO_DE_VERDADE)).toBeNull();
    expect(screen.getByTestId("memoria-leitura-falhou").textContent).toContain(AVISO_DE_FALHA);
    expect(screen.getByTestId("memoria-documento-falha").textContent).toContain(
      "Não consegui ler a versão ativa",
    );
  });

  it("as quatro leituras falham: nenhum texto de vazio aparece, e a ação de tentar de novo existe", async () => {
    banco.erroEm = { ponteiros: true, versaoAtiva: true, versoes: true, aprendizados: true };

    await abrir();

    expect(screen.queryByText(VAZIO_DE_VERDADE)).toBeNull();
    expect(screen.queryByText(APRENDIZADO_DE_VERDADE)).toBeNull();
    expect(screen.getByTestId("memoria-leitura-falhou")).not.toBeNull();
    expect(screen.getByTestId("memoria-versoes-falha").textContent).toContain(
      "Não consegui ler o histórico de versões agora.",
    );
    expect(screen.getByTestId("memoria-aprendizados-falha").textContent).toContain(
      "Não consegui ler os aprendizados agora.",
    );
    expect(screen.getByTestId("memoria-tentar-de-novo")).not.toBeNull();
  });

  it("só os aprendizados falham: o documento publicado continua na tela", async () => {
    banco.erroEm.aprendizados = true;

    await abrir();

    expect(screen.getByDisplayValue(banco.conteudo)).not.toBeNull();
    expect(screen.queryByText(VAZIO_DE_VERDADE)).toBeNull();
    expect(screen.queryByText(APRENDIZADO_DE_VERDADE)).toBeNull();
    expect(screen.getByTestId("memoria-aprendizados-falha")).not.toBeNull();
  });
});

describe("o aviso cede quando a releitura do cliente dá certo", () => {
  const RELIDO = {
    data: {
      document: {
        version_id: "v1",
        version_number: 3,
        content: "Sempre confirme o prazo de entrega antes de prometer.",
        created_at: "2026-10-01T00:00:00Z",
      },
      versions: [{ id: "v1", version_number: 3, created_at: "2026-10-01T00:00:00Z" }],
      entries: [],
    },
  };

  it("releitura bem-sucedida: some o aviso, e a lista vazia de verdade volta a dizer vazio", async () => {
    // A página falhou ao ler os aprendizados; a rota, relida pelo cliente,
    // respondeu — e respondeu que não há nenhum.
    banco.erroEm.aprendizados = true;
    api.get.mockResolvedValue(RELIDO);

    await abrir();

    await waitFor(() => expect(screen.queryByTestId("memoria-leitura-falhou")).toBeNull());
    expect(screen.queryByTestId("memoria-aprendizados-falha")).toBeNull();
    expect(screen.getByText(APRENDIZADO_DE_VERDADE)).not.toBeNull();
  });

  it("releitura que também falha: o aviso continua", async () => {
    banco.erroEm.aprendizados = true;
    api.get.mockRejectedValue(new Error("HTTP 500"));

    await abrir();

    await waitFor(() => expect(api.get).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByTestId("memoria-tentar-de-novo").textContent).toContain("Tentar de novo"),
    );
    expect(screen.getByTestId("memoria-leitura-falhou")).not.toBeNull();
    expect(screen.queryByText(APRENDIZADO_DE_VERDADE)).toBeNull();
  });
});

describe("leitura ok e sem conteúdo continua dizendo que está vazio", () => {
  it("sem versão e sem aprendizado: os textos de vazio de sempre, e nenhum aviso de falha", async () => {
    // Estado de uma instalação nova: o ponteiro responde "não há linha".
    banco.temPonteiro = false;
    banco.versoes = [];
    banco.conteudo = "";

    await abrir();

    expect(screen.queryByTestId("memoria-leitura-falhou")).toBeNull();
    expect(screen.queryByTestId("memoria-documento-falha")).toBeNull();
    expect(screen.getByText(VAZIO_DE_VERDADE)).not.toBeNull();
    expect(screen.getByText(APRENDIZADO_DE_VERDADE)).not.toBeNull();
  });
});
