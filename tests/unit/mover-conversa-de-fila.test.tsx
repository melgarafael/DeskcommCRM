/**
 * #3876 — "Mover para fila": o consumidor que faltava do
 * `PUT /api/v1/conversations/[id]/sector`.
 *
 * ─── O que estava medido antes desta fatia ──────────────────────────────────
 *
 * A rota existe desde a 9062, com papel mínimo `agent`, módulo Setores
 * conferido antes de autorizar, 409 para conversa encerrada e 422 para setor de
 * outra organização. E `git grep 'conversations/\[id\]/sector'` em
 * `components/` devolvia ZERO: nenhuma tela a chamava. Por isso os casos aqui
 * são os do GESTO:
 *
 *   1. o item do menu manda `PUT .../sector` com o `sector_id` escolhido;
 *   2. o item SÓ EXISTE para quem a rota aceita (`agent`+, módulo ligado,
 *      conversa aberta) — esconder é o certo aqui, ao contrário do export:
 *      ninguém precisa ver uma ação de escrita que nunca vai poder usar;
 *   3. a fila aparece com a COR que ela já tem (migration 9084) e com o selo
 *      "Fila atual", para o operador não reciclar a conversa onde ela já está.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  papel: "agent" as string | undefined,
  modulos: ["setores"] as string[],
  filas: [
    { id: "fila-comercial", name: "Comercial", color: "#ff8800", description: null, created_at: "", updated_at: "", member_count: 2, schedule: {} },
    { id: "fila-suporte", name: "Suporte", color: null, description: null, created_at: "", updated_at: "", member_count: 3, schedule: {} },
  ],
}));

const put = vi.fn(async (_url: string, _corpo: unknown) => ({
  data: { id: "conversa-1", sector_id: "fila-suporte", redistribuiu: false },
}));
const get = vi.fn(async (_url: string) => ({ data: h.filas }));

vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: (url: string) => get(url),
    put: (url: string, body: unknown) => put(url, body),
  },
}));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({
    user: { id: "u1", support: null },
    activeOrg:
      h.papel === undefined
        ? null
        : { role: h.papel, orgId: "org-1", modulos_ligados: h.modulos },
  }),
}));

import {
  DialogoMoverParaFila,
  ItemMoverParaFila,
  podeMoverParaFila,
} from "@/components/inbox/MoverParaFila";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

function comQuery(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

/**
 * O item mora num `DropdownMenu` (o Radix exige o contexto do menu), e é assim
 * que ele é montado de verdade — abrir o ⋯ é o gesto que o operador faz.
 */
function comMenu(ui: React.ReactElement) {
  return comQuery(
    <DropdownMenu open>
      <DropdownMenuTrigger asChild>
        <button type="button" data-testid="gatilho-do-menu">
          ⋯
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>{ui}</DropdownMenuContent>
    </DropdownMenu>,
  );
}

beforeEach(() => {
  h.papel = "agent";
  h.modulos = ["setores"];
  put.mockClear();
  get.mockClear();
});

afterEach(() => cleanup());

describe("#3876 — o item do ⋯ só existe para quem a rota aceita", () => {
  it("agent com o módulo ligado vê o item", () => {
    comMenu(<ItemMoverParaFila encerrada={false} onAbrir={vi.fn()} />);
    expect(screen.getByTestId("acao-mover-para-fila").textContent).toContain("Mover para fila");
  });

  it("o separador vem junto com o item — e some junto, sem dobrar o do menu", () => {
    const visto = comMenu(<ItemMoverParaFila encerrada={false} onAbrir={vi.fn()} />);
    expect(screen.getByTestId("separador-mover-para-fila")).toBeTruthy();
    visto.unmount();

    // Módulo desligado é o padrão: nem item, nem separador sobrando.
    h.modulos = [];
    comMenu(<ItemMoverParaFila encerrada={false} onAbrir={vi.fn()} />);
    expect(screen.queryByTestId("acao-mover-para-fila")).toBeNull();
    expect(screen.queryByTestId("separador-mover-para-fila")).toBeNull();
  });

  it("viewer NÃO vê: a rota responderia 403", () => {
    h.papel = "viewer";
    comMenu(<ItemMoverParaFila encerrada={false} onAbrir={vi.fn()} />);
    expect(screen.queryByTestId("acao-mover-para-fila")).toBeNull();
  });

  it("módulo Setores desligado NÃO vê: a rota responderia 404", () => {
    h.modulos = [];
    comMenu(<ItemMoverParaFila encerrada={false} onAbrir={vi.fn()} />);
    expect(screen.queryByTestId("acao-mover-para-fila")).toBeNull();
  });

  it("conversa encerrada NÃO vê: a rota responderia 409", () => {
    comMenu(<ItemMoverParaFila encerrada onAbrir={vi.fn()} />);
    expect(screen.queryByTestId("acao-mover-para-fila")).toBeNull();
  });

  it("a régua é a mesma das três recusas da rota", () => {
    expect(podeMoverParaFila({ papel: "agent", modulos: ["setores"], encerrada: false })).toBe(true);
    expect(podeMoverParaFila({ papel: "viewer", modulos: ["setores"], encerrada: false })).toBe(false);
    expect(podeMoverParaFila({ papel: "agent", modulos: [], encerrada: false })).toBe(false);
    expect(podeMoverParaFila({ papel: "agent", modulos: ["setores"], encerrada: true })).toBe(false);
    // Plataforma não depende de módulo ligado? Depende: a rota confere o módulo
    // ANTES de autorizar (404 para instalação que não tem Setores).
    expect(
      podeMoverParaFila({ papel: "viewer", modulos: ["setores"], encerrada: false, plataformaAdmin: true }),
    ).toBe(true);
    expect(
      podeMoverParaFila({ papel: "viewer", modulos: [], encerrada: true, plataformaAdmin: true }),
    ).toBe(false);
  });
});

describe("#3876 — o diálogo grava a fila pelo PUT que já existia", () => {
  it("manda PUT .../sector com o sector_id escolhido", async () => {
    comQuery(
      <DialogoMoverParaFila
        conversationId="conversa-1"
        filaAtual="fila-comercial"
        aberto
        onAbertoChange={vi.fn()}
      />,
    );

    const suporte = await screen.findByRole("button", { name: /Suporte/ });
    fireEvent.click(suporte);
    fireEvent.click(screen.getByRole("button", { name: "Mover" }));

    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put).toHaveBeenCalledWith("/api/v1/conversations/conversa-1/sector", {
      sector_id: "fila-suporte",
    });
  });

  it("mostra a cor da fila (migration 9084) e marca a fila atual", async () => {
    comQuery(
      <DialogoMoverParaFila
        conversationId="conversa-1"
        filaAtual="fila-comercial"
        aberto
        onAbertoChange={vi.fn()}
      />,
    );

    await screen.findByRole("button", { name: /Comercial/ });
    const ponto = document.querySelector('[data-cor-da-fila="fila-comercial"]') as HTMLElement | null;
    expect(ponto).not.toBeNull();
    expect(ponto?.style.backgroundColor).toBe("rgb(255, 136, 0)");
    // Fila sem cor não desenha ponto nenhum: "sem cor" não é "cinza".
    expect(document.querySelector('[data-cor-da-fila="fila-suporte"]')).toBeNull();
    expect(screen.getAllByText("Fila atual")).toHaveLength(1);
  });

  it("o botão Mover fica desabilitado até uma fila ser escolhida", async () => {
    comQuery(
      <DialogoMoverParaFila conversationId="conversa-1" filaAtual={null} aberto onAbertoChange={vi.fn()} />,
    );
    const mover = await screen.findByRole("button", { name: "Mover" });
    expect(mover.hasAttribute("disabled")).toBe(true);
    expect(put).not.toHaveBeenCalled();
  });
});
