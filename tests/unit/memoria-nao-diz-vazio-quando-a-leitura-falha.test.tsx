/**
 * A TELA DA MEMÓRIA NÃO CHAMA DE "VAZIO" O QUE ELA NÃO CONSEGUIU LER (#4171).
 *
 * ─── O defeito medido ───────────────────────────────────────────────────────
 *
 * `app/app/ai/memory/page.tsx` fazia quatro leituras com o cliente do usuário
 * (RLS) e usava só `data`, nunca `error`. Qualquer falha — policy negando o
 * select, coluna ausente (`valid_until`, migration 0790), timeout — virava
 * `null`/`[]`, e o cliente desenhava "Nenhuma versão publicada ainda" e
 * "Nenhum aprendizado ainda". Os agentes leem a memória por outro caminho (o
 * pool do servidor) e continuavam usando o texto: a tela mentia sobre o
 * trabalho de quem instalou, e convidava a pessoa a reescrever por cima de uma
 * memória que estava lá.
 *
 * ─── Por que a página inteira, e não o cliente ──────────────────────────────
 *
 * A decisão de mostrar vazio ou "não consegui ler" nasce no SERVIDOR, onde o
 * erro da leitura existe. Testar `OrgMemoryClient` com um `initialState`
 * montado à mão provaria só que ele sabe desenhar a falha; não provaria que a
 * página entrega essa falha em vez de engoli-la — que é exatamente o defeito.
 * Aqui a página é montada inteira sobre um banco de dublê que falha em UMA
 * tabela por vez.
 *
 * O caso "tudo vazio de verdade" fica junto de propósito: a correção não pode
 * trocar o vazio honesto por um erro em toda tela, e é este par que impede a
 * troca.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "11111111-1111-4111-8111-111111111111";

const banco = vi.hoisted(() => ({
  ponteiro: "v1" as string | null,
  documento: {
    id: "v1",
    version_number: 7,
    content: "Política da casa",
    created_at: "2026-10-01T00:00:00Z",
  } as Record<string, unknown> | null,
  versoes: [] as Record<string, unknown>[],
  entradas: [] as Record<string, unknown>[],
  /**
   * tabela/leitura → mensagem do erro devolvido pelo banco. As chaves são as
   * leituras da página: `ponteiros`, `documento`, `versoes`, `entradas`.
   */
  erro: {} as Record<string, string>,
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
// O refetch do cliente fica pendente: o que se mede aqui é o estado que veio
// da página, não a segunda leitura.
vi.mock("@/lib/api/client", () => ({
  apiClient: { get: vi.fn(() => new Promise(() => {})), post: vi.fn(), patch: vi.fn() },
}));
vi.mock("@/hooks/auth/AuthProvider", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  usePermission: () => true,
}));
vi.mock("@/lib/auth/server", () => ({
  requireAuth: vi.fn(async () => ({ id: "actor", idioma: "pt-BR", is_platform_admin: false, support: null })),
  resolveActiveOrg: vi.fn(async () => ({
    orgId: ORG,
    role: "admin",
    timezone: "America/Sao_Paulo",
  })),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (tabela: string) => {
      const erro = (chave: string) =>
        banco.erro[chave] ? { message: banco.erro[chave] as string } : null;
      const chain: Record<string, unknown> = {
        maybeSingle: async () => {
          if (tabela === "organizations") return { data: { settings: {} }, error: null };
          if (tabela === "org_memory_pointers")
            return {
              data: banco.ponteiro === null ? null : { version_id: banco.ponteiro },
              error: erro("ponteiros"),
            };
          if (tabela === "org_memory_versions")
            return {
              // O banco real não devolve linha quando a leitura falha.
              data: banco.erro.documento ? null : banco.documento,
              error: erro("documento"),
            };
          return { data: null, error: null };
        },
        then: (ok: (v: unknown) => unknown, nao: (e: unknown) => unknown) =>
          Promise.resolve({
            data: tabela === "org_memory_versions" ? banco.versoes : banco.entradas,
            error: erro(tabela === "org_memory_versions" ? "versoes" : "entradas"),
          }).then(ok, nao),
      };
      for (const m of ["select", "eq", "neq", "order", "limit"]) chain[m] = () => chain;
      return chain;
    },
  }),
}));

import OrgMemoryPage from "@/app/app/ai/memory/page";

async function abrir(qcExistente?: QueryClient) {
  const pagina = await OrgMemoryPage();
  const qc = qcExistente ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}>{pagina}</QueryClientProvider>);
}

const VAZIO_DO_DOCUMENTO = "Nenhuma versão publicada ainda";
const VAZIO_DOS_APRENDIZADOS = /Nenhum aprendizado ainda/;

beforeEach(() => {
  vi.clearAllMocks();
  banco.ponteiro = "v1";
  banco.documento = {
    id: "v1",
    version_number: 7,
    content: "Política da casa",
    created_at: "2026-10-01T00:00:00Z",
  };
  banco.versoes = [{ id: "v1", version_number: 7, created_at: "2026-10-01T00:00:00Z" }];
  banco.entradas = [];
  banco.erro = {};
});
afterEach(cleanup);

describe("a leitura que falhou não vira memória vazia", () => {
  it("aprendizados com erro de leitura não dizem 'Nenhum aprendizado ainda'", async () => {
    banco.erro = { entradas: "column org_memory_entries.valid_until does not exist" };
    await abrir();
    expect(screen.queryByText(VAZIO_DOS_APRENDIZADOS)).toBeNull();
    expect(screen.getByText("Não consegui ler os aprendizados")).not.toBeNull();
  });

  it("versão publicada que não pôde ser lida não diz 'Nenhuma versão publicada ainda'", async () => {
    banco.erro = { documento: "permission denied for table org_memory_versions" };
    await abrir();
    expect(screen.queryByText(VAZIO_DO_DOCUMENTO)).toBeNull();
    expect(screen.getByText("Não consegui ler a versão publicada")).not.toBeNull();
  });

  it("a tela avisa que o vazio pode ser falta de leitura, e oferece tentar de novo", async () => {
    banco.erro = { entradas: "timeout" };
    await abrir();
    expect(screen.getByRole("alert").textContent).toContain("não pôde ser lida");
    expect(screen.getByRole("button", { name: "Tentar de novo" })).not.toBeNull();
  });

  it("vazio DE VERDADE continua vazio — a correção não inventa erro", async () => {
    banco.ponteiro = null;
    banco.documento = null;
    banco.versoes = [];
    banco.entradas = [];
    await abrir();
    expect(screen.getByText(VAZIO_DO_DOCUMENTO)).not.toBeNull();
    expect(screen.getByText(VAZIO_DOS_APRENDIZADOS)).not.toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("cache antigo com o nome global da memória não esconde o que o servidor acabou de ler", async () => {
    // O sintoma da issue: o servidor seleciona certo e a tela reidrata vazia.
    // Com a chave sem empresa, `initialData` é DESCARTADO quando já existe
    // cache para o nome — e o cache de uma leitura vazia anterior (ou de outra
    // empresa) vence o estado fresco.
    banco.entradas = [
      {
        id: "e1",
        title: "Não oferecer frete grátis no primeiro contato",
        body: "Confirmar com um humano.",
        source: "manual",
        status: "active",
        created_at: "2026-10-02T00:00:00Z",
        valid_until: null,
      },
    ];
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["org-memory"], { document: null, versions: [], entries: [] });
    await abrir(qc);
    expect(screen.getByText("Não oferecer frete grátis no primeiro contato")).not.toBeNull();
  });

  it("leitura inteira boa com versão publicada mostra a versão e os aprendizados", async () => {
    banco.entradas = [
      {
        id: "e1",
        title: "Não oferecer frete grátis no primeiro contato",
        body: "Confirmar com um humano.",
        source: "manual",
        status: "active",
        created_at: "2026-10-02T00:00:00Z",
        valid_until: null,
      },
    ];
    await abrir();
    expect(screen.getAllByText(/v7/).length).toBeGreaterThan(0);
    expect(screen.getByText("Não oferecer frete grátis no primeiro contato")).not.toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
