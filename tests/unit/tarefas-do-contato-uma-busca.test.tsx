/**
 * AS TAREFAS DO CONTATO NO PAINEL DA CONVERSA (#4630) — o custo da seção.
 *
 * Com o #4630, a seção de tarefas do painel deixou de existir só com demanda
 * vigente: ela aparece em TODA conversa com contato. Isso é uma busca a mais
 * por conversa aberta, e o que este arquivo segura é o tamanho dessa conta:
 *
 *   - é UMA busca, filtrada pelo contato (a organização a rota tira da sessão,
 *     ver `tarefas-setor-e-filtro.test.ts`);
 *   - ela não se repete a cada render do painel (a mesma chave de consulta);
 *   - conversa sem contato (e sem demanda) não busca nada.
 *
 * Aqui o `useTasks` é o de verdade, com o `fetch` espionado: um dublê do hook
 * não veria uma segunda busca.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useTagDeIdioma: () => "pt-BR" }));
vi.mock("@/hooks/auth/AuthProvider", () => ({ useUser: () => ({ id: "u-eu" }) }));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({
  useAssignableMembers: () => ({ isSuccess: true, data: [] }),
}));

import { TarefasDaDemanda } from "@/components/inbox/TarefasDaDemanda";

const fetchEspiao = vi.fn(async (_url: string) =>
  new Response(JSON.stringify({ data: { tasks: [] } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }),
);
const buscasDeTarefas = () =>
  fetchEspiao.mock.calls.map(([url]) => String(url)).filter((url) => url.startsWith("/api/v1/tasks"));

function comCliente(client: QueryClient) {
  return function Envolve({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

beforeEach(() => {
  fetchEspiao.mockClear();
  vi.stubGlobal("fetch", fetchEspiao);
});

describe("tarefas do contato no painel (#4630)", () => {
  it("⭐ uma busca só, pelo contato, e ela não se repete a cada render", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = render(<TarefasDaDemanda demandaId={null} contactId="c-1" podeEditar />, {
      wrapper: comCliente(client),
    });
    await waitFor(() => expect(screen.getByText(/Nenhuma tarefa para este contato/)).toBeTruthy());

    for (let i = 0; i < 3; i++) {
      rerender(<TarefasDaDemanda demandaId={null} contactId="c-1" podeEditar />);
    }
    await new Promise((r) => setTimeout(r, 20));

    expect(buscasDeTarefas()).toEqual(["/api/v1/tasks?contact_id=c-1&aberto=true"]);
  });

  it("com demanda vigente, a busca é pela demanda — e continua sendo uma só", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<TarefasDaDemanda demandaId="d-1" contactId="c-1" podeEditar />, { wrapper: comCliente(client) });
    await waitFor(() => expect(buscasDeTarefas()).toHaveLength(1));
    expect(buscasDeTarefas()[0]).toBe("/api/v1/tasks?demanda_id=d-1&aberto=true");
  });

  it("⭐ conversa sem contato e sem demanda não busca nada", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(<TarefasDaDemanda demandaId={null} contactId={null} podeEditar />, {
      wrapper: comCliente(client),
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(container.firstChild).toBeNull();
    expect(fetchEspiao).not.toHaveBeenCalled();
  });
});
