/**
 * #3876 (metade "filas visíveis") — a fila vira FILTRO da lista, CONTAGEM por
 * fila e COR no seletor do Inbox.
 *
 * ─── O que foi medido antes desta fatia ─────────────────────────────────────
 *
 * `GET /api/v1/conversations` não aceitava `sector`, e nenhum controle da tela
 * pedia fila: a coluna `conversations.sector_id` existia desde a 9062, a cor
 * desde a 9084, e a tela não lia nenhuma das duas. Por isso os casos abaixo
 * atravessam a cadeia inteira, na ordem em que ela rompe em silêncio:
 *
 *   schema (aceita) → rota (lê da URL) → handler (filtra no WHERE) →
 *   hook (serializa) → contagem (conta a fila escolhida E cada fila).
 *
 * A rotura em QUALQUER elo é invisível para o typecheck — é literalmente o
 * defeito que `rota-le-todo-filtro-do-schema` já pegou duas vezes (`tag`,
 * `comando`). Aqui ele é medido elo por elo, e o elo do desenho (a cor no
 * seletor) é medido em DOM de verdade.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const FILA = "11111111-1111-4111-8111-111111111111";

const h = vi.hoisted(() => ({
  modulos: ["setores"] as string[],
  filas: [
    { id: "11111111-1111-4111-8111-111111111111", name: "Comercial", color: "#2277ff", description: null, created_at: "", updated_at: "", member_count: 1, schedule: {} },
    { id: "22222222-2222-4222-8222-222222222222", name: "Suporte", color: null, description: null, created_at: "", updated_at: "", member_count: 2, schedule: {} },
  ],
}));

vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: vi.fn(async (url: string) => {
      if (url.startsWith("/api/v1/attendants/sectors")) return { data: h.filas };
      if (url.startsWith("/api/v1/conversations/counts"))
        return { data: { unassigned: 0, mine: 0, all: 0, por_fila: { [FILA]: 3 } } };
      return { data: [] };
    }),
  },
}));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({
    user: { id: "u1", support: null },
    activeOrg: {
      orgId: "00000000-0000-4000-8000-0000000000aa",
      role: "agent",
      visibility_mode: "all",
      modulos_ligados: h.modulos,
    },
  }),
  usePermission: () => true,
}));

import { InboxFilters, OpcaoDaFila, type InboxFiltersValue } from "@/components/inbox/InboxFilters";
import { filtrosAuxiliaresDaContagem } from "@/app/api/v1/conversations/counts/route";
import { listConversationsQuerySchema } from "@/lib/schemas";

const raiz = process.cwd();
const fonte = (rel: string) => readFileSync(join(raiz, rel), "utf8");

beforeEach(() => {
  h.modulos = ["setores"];
});

afterEach(() => cleanup());

describe("#3876 — a fila atravessa schema, rota e handler", () => {
  it("o schema aceita sector_id (uuid) e recusa o que não é uuid", () => {
    expect(listConversationsQuerySchema.safeParse({ sector_id: FILA }).success).toBe(true);
    expect(listConversationsQuerySchema.safeParse({ sector_id: "comercial" }).success).toBe(false);
    // Ausente continua valendo: o parâmetro é auxiliar, como `tag` e `canal`.
    expect(listConversationsQuerySchema.safeParse({}).success).toBe(true);
  });

  it("a rota LÊ sector_id da URL (o elo que o typecheck não pega)", () => {
    const rota = fonte("app/api/v1/conversations/route.ts");
    expect(rota).toMatch(/sector_id:\s*url\.searchParams\.get\("sector_id"\)/);
  });

  it("o handler filtra pela coluna, no WHERE — antes do `limit`", () => {
    const handler = fonte("app/api/v1/conversations/_handler.ts");
    expect(handler).toMatch(/if \(q\.sector_id\) query = query\.eq\("sector_id", q\.sector_id\);/);
    // E a coluna vem na seleção: sem ela a linha não saberia — nem a tela —
    // em que fila a conversa está.
    expect(handler).toMatch(/snooze_until, sector_id, created_at, updated_at/);
  });

  it("o hook serializa sector_id no GET da lista", () => {
    const hook = fonte("hooks/inbox/useConversationsRealtime.ts");
    expect(hook).toMatch(/if \(filters\.sector_id\) qs\.set\("sector_id", filters\.sector_id\);/);
  });
});

describe("#3876 — a contagem por fila", () => {
  it("a contagem da aba aplica a fila escolhida (badge não conta o que a lista esconde)", () => {
    const filtros = filtrosAuxiliaresDaContagem(new URLSearchParams({ sector_id: FILA }));
    expect(filtros).toContainEqual(["sector_id", FILA]);
  });

  it("id que não é uuid não entra: contagem ignora em vez de divergir", () => {
    const filtros = filtrosAuxiliaresDaContagem(new URLSearchParams({ sector_id: "comercial" }));
    expect(filtros.some(([coluna]) => coluna === "sector_id")).toBe(false);
  });

  it("a rota devolve `por_fila` por setor, com o predicado da Fila", () => {
    const rota = fonte("app/api/v1/conversations/counts/route.ts");
    expect(rota).toMatch(/por_fila: Object\.fromEntries\(contagensPorFila\)/);
    expect(rota).toMatch(/countExact\(\[\.\.\.semOFiltroDaTela, \["sector_id", idDaFila\] as const\]\)/);
    expect(rota).toMatch(/comandosDaFila\(automaticoDaOrg\)/);
    // O filtro da TELA não pode entrar na contagem POR fila: `sector_id = A AND
    // sector_id = B` zeraria todas as filas menos uma.
    expect(rota).toMatch(/auxiliares\.filter\(\(\[coluna\]\) => coluna !== "sector_id"\)/);
  });
});

describe("#3876 — o seletor mostra a fila com a cor dela", () => {
  it("a opção desenha cor, nome e quantas esperam", () => {
    render(<OpcaoDaFila fila={h.filas[0]!} esperando={3} />);
    const ponto = document.querySelector('[data-cor-da-fila="11111111-1111-4111-8111-111111111111"]') as HTMLElement;
    expect(ponto.style.backgroundColor).toBe("rgb(34, 119, 255)");
    expect(screen.getByText("Comercial")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
  });

  it("fila sem cor não desenha ponto, e fila vazia não desenha zero", () => {
    render(<OpcaoDaFila fila={h.filas[1]!} esperando={0} />);
    expect(document.querySelector("[data-cor-da-fila]")).toBeNull();
    expect(screen.queryByText("0")).toBeNull();
  });

  it("o seletor existe quando a organização tem filas", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <InboxFilters
          value={{ tab: "all", search: "", onlyUnread: false }}
          onChange={vi.fn()}
          filas={h.filas}
        />
      </QueryClientProvider>,
    );
    const gatilho = await screen.findByTestId("filtro-de-fila");
    expect(gatilho.getAttribute("aria-label")).toBe("Filtrar por fila");
    expect(gatilho.textContent).toContain("Todas as filas");
  });

  it("organização sem filas NÃO desenha o seletor (módulo Setores desligado ou sem fila)", async () => {
    // A página só passa lista quando o módulo está ligado e há fila; ausente é
    // o caso de quem não usa Setores — e um controle que abre lista vazia é
    // ruído na coluna de 280 px.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <InboxFilters value={{ tab: "all", search: "", onlyUnread: false }} onChange={vi.fn()} />
      </QueryClientProvider>,
    );
    // A prova de que o componente montou: o campo de busca, que existe sempre.
    await screen.findByLabelText("Buscar conversas");
    expect(screen.queryByTestId("filtro-de-fila")).toBeNull();
  });

  it("o valor escolhido vira `sector_id` no estado do filtro", () => {
    const valor: InboxFiltersValue = {
      tab: "all",
      search: "",
      onlyUnread: false,
      sector_id: FILA,
    };
    expect(valor.sector_id).toBe(FILA);
    // E o layout repassa esse mesmo campo para a lista.
    const layout = fonte("components/inbox/InboxLayout.tsx");
    expect(layout).toMatch(/sector_id: filterValue\.sector_id,/);
  });
});
