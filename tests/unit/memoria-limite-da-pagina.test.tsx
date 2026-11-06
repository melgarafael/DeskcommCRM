/**
 * O LIMITE DO AVISO DE PESO CHEGA DO BANCO À TELA, PELA PÁGINA.
 *
 * Decisão do dono (31/10): o limite é configurável por empresa. Os testes de
 * `PesoDaMemoria` e `LimiteDoAviso` recebem o limite à mão, e por isso ficam
 * verdes se a página deixar de ler `settings.memoria_da_ia` ou se o cliente
 * passar o recomendado no lugar do valor salvo: o admin grava, vê «Salvo», e a
 * tela segue avisando a partir de 1.500. Aqui a página é montada inteira, com o
 * banco semeado.
 *
 * E quem edita é o critério da action (admin, fora de acompanhamento somente
 * leitura), não `usePermission("ai.memory.publish")`, que libera o platform
 * admin que a action recusa com «Só um administrador pode mudar esse limite».
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "11111111-1111-4111-8111-111111111111";

const banco = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  conteudo: "",
  role: "admin" as string,
  isPlatformAdmin: false,
  support: null as null | { status: string; access_mode: string; organization_id: string },
  /** O que `usePermission("ai.memory.publish")` devolveria para esse usuário. */
  podePublicar: true,
}));
const { definir } = vi.hoisted(() => ({ definir: vi.fn() }));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
// As queries da tela nascem com o estado da página; o refetch fica pendente.
vi.mock("@/lib/api/client", () => ({
  apiClient: { get: vi.fn(() => new Promise(() => {})), post: vi.fn(), patch: vi.fn() },
}));
vi.mock("@/app/actions/settings/definirLimiteDoPesoDaMemoria", () => ({
  definirLimiteDoPesoDaMemoria: definir,
}));
vi.mock("@/hooks/auth/AuthProvider", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  usePermission: () => banco.podePublicar,
}));
vi.mock("@/lib/auth/server", () => ({
  requireAuth: vi.fn(async () => ({
    id: "actor",
    idioma: "pt-BR",
    is_platform_admin: banco.isPlatformAdmin,
    support: banco.support,
  })),
  resolveActiveOrg: vi.fn(async () => ({ orgId: ORG, role: banco.role, timezone: "America/Sao_Paulo" })),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (tabela: string) => {
      const chain: Record<string, unknown> = {
        then: (ok: (v: unknown) => unknown, erro: (e: unknown) => unknown) =>
          Promise.resolve({ data: [], error: null }).then(ok, erro),
        maybeSingle: async () => ({
          data:
            tabela === "organizations"
              ? { settings: banco.settings }
              : tabela === "org_memory_pointers"
                ? { version_id: "v1" }
                : tabela === "org_memory_versions"
                  ? { id: "v1", version_number: 1, content: banco.conteudo, created_at: "2026-10-01T00:00:00Z" }
                  : null,
          error: null,
        }),
      };
      for (const m of ["select", "eq", "neq", "order"]) chain[m] = () => chain;
      return chain;
    },
  }),
}));

import OrgMemoryPage from "@/app/app/ai/memory/page";
import { pesoDaMemoriaEmTokens } from "@/app/app/ai/memory/_client";

// 3.500 caracteres ≈ 1.000 tokens: abaixo do recomendado (1.500), acima de 800.
const MEDIO = "c".repeat(3_500);

async function abrir() {
  const pagina = await OrgMemoryPage();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}>{pagina}</QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  banco.settings = {};
  banco.conteudo = MEDIO;
  banco.role = "admin";
  banco.isPlatformAdmin = false;
  banco.support = null;
  banco.podePublicar = true;
});
afterEach(cleanup);

describe("a página entrega à tela o limite salvo da empresa", () => {
  it("premissa: o texto médio fica entre 800 e o recomendado", () => {
    const peso = pesoDaMemoriaEmTokens(MEDIO, [], "2026-10-31");
    expect(peso).toBeGreaterThan(800);
    expect(peso).toBeLessThan(1_500);
  });

  it("sem escolha salva, vale o recomendado e o texto médio não acende o aviso", async () => {
    await abrir();
    expect((screen.getByRole("spinbutton") as HTMLInputElement).value).toBe("1500");
    expect(screen.queryByTestId("memoria-peso-aviso")).toBeNull();
  });

  it("com 800 salvo, o campo mostra 800 e o mesmo texto acende o aviso", async () => {
    banco.settings = { memoria_da_ia: { limite_do_aviso_tokens: 800 } };
    await abrir();
    expect((screen.getByRole("spinbutton") as HTMLInputElement).value).toBe("800");
    expect(screen.getByTestId("memoria-peso-aviso")).not.toBeNull();
  });

  it("gravar um limite novo passa a valer na mesma tela, sem recarregar", async () => {
    banco.settings = { memoria_da_ia: { limite_do_aviso_tokens: 800 } };
    definir.mockResolvedValue({ ok: true, valor: 5_000, mudou: true });
    await abrir();
    expect(screen.getByTestId("memoria-peso-aviso")).not.toBeNull();
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "5000" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(screen.queryByTestId("memoria-peso-aviso")).toBeNull());
    expect(definir).toHaveBeenCalledWith(5_000);
  });
});

describe("quem edita o limite é quem a action aceita", () => {
  it("admin da empresa recebe o campo", async () => {
    await abrir();
    expect(screen.getByRole("spinbutton")).not.toBeNull();
  });

  it("gerente vê o limite em vigor, sem campo", async () => {
    banco.role = "manager";
    banco.podePublicar = false;
    banco.settings = { memoria_da_ia: { limite_do_aviso_tokens: 3_000 } };
    await abrir();
    expect(screen.queryByRole("spinbutton")).toBeNull();
    expect(screen.getByTestId("memoria-limite").textContent).toContain("3.000");
  });

  it("platform admin com papel de gerente não recebe o campo que a action recusaria", async () => {
    banco.role = "manager";
    banco.isPlatformAdmin = true;
    banco.podePublicar = true; // `usePermission` libera o platform admin fora de acompanhamento
    await abrir();
    expect(screen.queryByRole("spinbutton")).toBeNull();
  });

  it("admin em acompanhamento somente leitura não recebe o campo", async () => {
    banco.support = { status: "active", access_mode: "read_only", organization_id: ORG };
    await abrir();
    expect(screen.queryByRole("spinbutton")).toBeNull();
  });
});
