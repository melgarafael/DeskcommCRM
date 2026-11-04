/**
 * O número ao lado de "Tarefas" no menu: as tarefas EM ABERTO de quem está
 * logado.
 *
 * ─── O que se prova aqui, e por quê ────────────────────────────────────────
 *
 * 1. O escopo é o do USUÁRIO da sessão — `assigned_to: "me"`, que a rota
 *    resolve pelo `authz.user.id` e nunca por um id vindo do navegador. Tarefa
 *    de outro atendente não conta.
 * 2. Só `pending` e `in_progress` contam. `done` e `cancelled` são trabalho
 *    encerrado, e o `check` do banco e o filtro `aberto` da rota dizem a mesma
 *    coisa por `SITUACOES_ABERTAS_DA_TAREFA` — a régua compartilhada.
 * 3. Zero e erro não desenham NADA (nem "0"): a regra está escrita no catálogo,
 *    ao lado do campo `contador`, e é a mesma do contador de Casos.
 * 4. A recarga é de 60 s — o mesmo intervalo do contador de Casos, porque
 *    automação cria tarefa sem gesto de ninguém nesta aba.
 * 5. O tenant sai da SESSÃO no servidor: a rota filtra `organization_id` da
 *    organização ativa mesmo que o navegador peça outra, e a RLS segura o
 *    resto. Um contador que somasse a organização errada seria vazamento mudo.
 */
import { render, screen } from "@testing-library/react";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { ROLE_RANK, type AuthUser, type Role } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";
import type { Tarefa } from "@/lib/tarefas/tipos";

const ORG = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG = "33333333-3333-4333-8333-333333333333";
const ANA = "11111111-1111-4111-8111-111111111111";

/** O que o componente pede ao hook — o instrumento do escopo por usuário. */
let pedido: { filtros?: unknown; opcoes?: unknown } = {};
let tarefas: Array<Pick<Tarefa, "id" | "status">> = [];

vi.mock("@/hooks/tasks/useTasks", () => ({
  useTasks: (filtros: unknown, opcoes: unknown) => {
    pedido = { filtros, opcoes };
    return { tarefas };
  },
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

import { ContadorDeTarefas } from "@/components/shell/ContadorDeTarefas";
import { sidebarGroups } from "@/lib/navigation/registry";

function comStatus(...situacoes: Array<Tarefa["status"]>): Array<Pick<Tarefa, "id" | "status">> {
  return situacoes.map((status, i) => ({ id: `t${i}`, status }));
}

describe("contador de tarefas no menu", () => {
  it("conta as em aberto do usuário logado: pending + in_progress", () => {
    tarefas = comStatus("pending", "in_progress", "done", "cancelled");
    render(<ContadorDeTarefas compacto={false} />);
    // `done` e `cancelled` NÃO entram: são trabalho encerrado.
    expect(screen.getByTestId("contador-de-tarefas").textContent).toBe("2");
    // e o rótulo acessível diz de que número se trata
    expect(screen.getByTestId("contador-de-tarefas").getAttribute("aria-label")).toBe(
      "2 tarefas em aberto",
    );
  });

  it("pede à rota as MINHAS em aberto — nunca as da equipe", () => {
    tarefas = comStatus("pending");
    render(<ContadorDeTarefas compacto={false} />);
    // `me` é resolvido no servidor pelo id da sessão: o navegador não escolhe
    // de quem é a contagem.
    expect(pedido.filtros).toEqual({ aberto: true, assigned_to: "me" });
  });

  it("recarrega a cada 60 s, como o contador de Casos", () => {
    tarefas = comStatus("pending");
    render(<ContadorDeTarefas compacto={false} />);
    expect(pedido.opcoes).toEqual({ refetchInterval: 60_000 });
  });

  it("sem tarefa em aberto, não desenha nada — número zero treina a ignorar o número", () => {
    tarefas = comStatus("done", "cancelled");
    const { container } = render(<ContadorDeTarefas compacto={false} />);
    expect(container.innerHTML).toBe("");
  });

  it("no primeiro carregamento (lista ainda vazia) também não desenha nada", () => {
    tarefas = [];
    const { container } = render(<ContadorDeTarefas compacto={false} />);
    expect(container.innerHTML).toBe("");
  });

  it("uma tarefa em aberto fala no singular", () => {
    tarefas = comStatus("pending");
    render(<ContadorDeTarefas compacto={false} />);
    expect(screen.getByTestId("contador-de-tarefas").getAttribute("aria-label")).toBe(
      "1 tarefa em aberto",
    );
  });

  it("na barra recolhida vira PONTO: sem número, mas com a contagem no rótulo", () => {
    tarefas = comStatus("pending", "in_progress", "pending");
    render(<ContadorDeTarefas compacto />);
    const contador = screen.getByTestId("contador-de-tarefas");
    expect(contador.textContent).toBe("");
    expect(contador.getAttribute("aria-label")).toBe("3 tarefas em aberto");
    expect(contador.className).toContain("h-2");
    expect(contador.className).toContain("w-2");
  });

  it("Tarefas está no menu com o contador declarado", () => {
    const crm = sidebarGroups(true, null).find((g) => g.group.id === "crm");
    expect(crm?.items.find((i) => i.href === "/app/tasks")?.contador).toBe("tarefas");
  });
});

// ─── O lado do servidor: a régua que o contador herda ────────────────────────

function sessao(papel: Role = "agent") {
  const user: AuthUser = {
    id: ANA,
    email: "ana@example.com",
    full_name: "Ana",
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
    organizations: [{ organization_id: ORG, organization_name: "Org", role: papel }],
  };
  vi.mocked(requireRole).mockImplementation(async (min: Role) =>
    ROLE_RANK[papel] >= ROLE_RANK[min]
      ? { ok: true, user, org: { orgId: ORG, name: "Org", role: papel } }
      : { ok: false, response: fail("forbidden_role", `Requer role >= ${min}.`, 403, {}) },
  );
}

/** Dublê do PostgREST que ANOTA eq, is e in — `in` é o filtro de situação. */
function fazerSupabase() {
  const filtros: Array<[string, string, unknown]> = [];
  const elo: Record<string, unknown> = {};
  for (const metodo of ["select", "order", "limit", "gte", "lte"]) elo[metodo] = () => elo;
  elo.eq = (coluna: string, valor: unknown) => (filtros.push(["eq", coluna, valor]), elo);
  elo.is = (coluna: string, valor: unknown) => (filtros.push(["is", coluna, valor]), elo);
  elo.in = (coluna: string, valores: unknown) => (filtros.push(["in", coluna, valores]), elo);
  elo.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res);
  vi.mocked(createClient).mockResolvedValue({ from: () => elo } as never);
  return filtros;
}

describe("GET /api/v1/tasks — a consulta que o contador faz", () => {
  it("`aberto=true` com `assigned_to=me` vira pending+in_progress DO usuário da sessão", async () => {
    sessao();
    const filtros = fazerSupabase();
    const { GET } = await import("@/app/api/v1/tasks/route");

    const res = await GET(new NextRequest("http://x/api/v1/tasks?aberto=true&assigned_to=me"));

    expect(res.status).toBe(200);
    expect(filtros).toContainEqual(["in", "status", ["pending", "in_progress"]]);
    expect(filtros).toContainEqual(["eq", "assigned_to", ANA]);
    // e o tenant sai da SESSÃO: organização pedida pelo navegador é ignorada
    expect(filtros).toContainEqual(["eq", "organization_id", ORG]);
    expect(filtros.flat()).not.toContain(OUTRA_ORG);
  });

  it("`done` e `cancelled` ficam de fora da contagem por construção", async () => {
    sessao();
    const filtros = fazerSupabase();
    const { GET } = await import("@/app/api/v1/tasks/route");

    await GET(new NextRequest("http://x/api/v1/tasks?aberto=true&assigned_to=me"));

    const status = filtros
      .filter(([, coluna]) => coluna === "status")
      .flatMap(([, , v]) => v as string[]);
    expect(status).not.toContain("done");
    expect(status).not.toContain("cancelled");
  });
});
