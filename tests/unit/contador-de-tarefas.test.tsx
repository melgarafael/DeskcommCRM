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
let tarefas: Array<Pick<Tarefa, "id" | "status" | "due_date">> = [];

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

function comStatus(
  ...situacoes: Array<Tarefa["status"]>
): Array<Pick<Tarefa, "id" | "status" | "due_date">> {
  return situacoes.map((status, i) => ({ id: `t${i}`, status, due_date: null }));
}

/** Prazo fixo: o de uma tarefa já vencida e o de uma que ainda não venceu. */
const VENCIDA = "2020-01-01T12:00:00-03:00";
const FUTURA = "2099-01-01T12:00:00-03:00";

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

// ─── Vencida: o destaque que o número sozinho não dava (#3938) ───────────────

describe("contador de tarefas: a vencida no menu", () => {
  it("com atraso, o selo ganha ícone de aviso e '· N atrasada' no rótulo, sem trocar o vermelho", () => {
    tarefas = [
      { id: "t0", status: "pending", due_date: VENCIDA },
      { id: "t1", status: "in_progress", due_date: FUTURA },
      { id: "t2", status: "pending", due_date: null },
    ];
    render(<ContadorDeTarefas compacto={false} />);
    const contador = screen.getByTestId("contador-de-tarefas");

    // O número continua sendo o de ABERTAS — atrasada é um recorte dele.
    expect(contador.textContent).toBe("3");
    expect(contador.getAttribute("data-atrasadas")).toBe("1");
    // A mesma frase do selo do card (`TarefasNoCard`), com a mesma régua.
    expect(contador.getAttribute("aria-label")).toBe("3 tarefas em aberto · 1 atrasada");
    expect(contador.className).toContain("bg-red-600");
    // O aviso é desenhado, não só falado: quem olha a barra vê o ícone.
    expect(contador.querySelector("svg")).not.toBeNull();
  });

  it("sem atraso, nada muda: selo normal, sem ícone e com data-atrasadas 0", () => {
    tarefas = [
      { id: "t0", status: "pending", due_date: FUTURA },
      { id: "t1", status: "pending", due_date: null },
    ];
    render(<ContadorDeTarefas compacto={false} />);
    const contador = screen.getByTestId("contador-de-tarefas");

    expect(contador.textContent).toBe("2");
    expect(contador.getAttribute("data-atrasadas")).toBe("0");
    expect(contador.getAttribute("aria-label")).toBe("2 tarefas em aberto");
    expect(contador.className).toContain("bg-red-600");
    expect(contador.querySelector("svg")).toBeNull();
  });

  it("prazo estourado de tarefa CONCLUÍDA não vira atraso — a regra é a da lista", () => {
    tarefas = [
      { id: "t0", status: "done", due_date: VENCIDA },
      { id: "t1", status: "cancelled", due_date: VENCIDA },
      { id: "t2", status: "in_progress", due_date: VENCIDA },
    ];
    render(<ContadorDeTarefas compacto={false} />);
    const contador = screen.getByTestId("contador-de-tarefas");

    expect(contador.textContent).toBe("1");
    expect(contador.getAttribute("data-atrasadas")).toBe("1");
    expect(contador.getAttribute("aria-label")).toBe("1 tarefa em aberto · 1 atrasada");
  });

  it("no ponto recolhido o atraso continua no rótulo, mesmo sem espaço para o ícone", () => {
    tarefas = [
      { id: "t0", status: "pending", due_date: VENCIDA },
      { id: "t1", status: "pending", due_date: VENCIDA },
    ];
    render(<ContadorDeTarefas compacto />);
    const contador = screen.getByTestId("contador-de-tarefas");

    expect(contador.textContent).toBe("");
    expect(contador.getAttribute("data-atrasadas")).toBe("2");
    expect(contador.getAttribute("aria-label")).toBe("2 tarefas em aberto · 2 atrasadas");
    expect(contador.querySelector("svg")).toBeNull();
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

/**
 * SONDA — o que a rota DEVOLVE, não só o que ela pede.
 *
 * Os testes acima leem o filtro; este aplica os filtros a uma lista de linhas e
 * confere a lista que sai. É a diferença entre "mandou `assigned_to = ana`" e
 * "a Ana recebe só as dela" — e é o que prova, para os três papéis, o limite
 * duro do #3938: gerente e administrador também veem apenas as próprias no
 * contador; a visão da equipe é a tela, não o menu.
 */
function fazerSupabaseSobre(linhas: Array<Record<string, unknown>>) {
  const filtros: Array<[string, string, unknown]> = [];
  const ordens: Array<{ coluna: string; ascendente: boolean }> = [];
  let teto = Number.POSITIVE_INFINITY;
  const elo: Record<string, unknown> = {};
  for (const metodo of ["select", "gte", "lte"]) elo[metodo] = () => elo;
  elo.eq = (coluna: string, valor: unknown) => (filtros.push(["eq", coluna, valor]), elo);
  elo.is = (coluna: string, valor: unknown) => (filtros.push(["is", coluna, valor]), elo);
  elo.in = (coluna: string, valores: unknown) => (filtros.push(["in", coluna, valores]), elo);
  elo.order = (coluna: string, opcoes?: { ascending?: boolean }) => (
    ordens.push({ coluna, ascendente: opcoes?.ascending ?? true }), elo
  );
  elo.limit = (n: number) => ((teto = n), elo);
  elo.then = (res: (v: unknown) => unknown) => {
    let saida = linhas.filter((linha) =>
      filtros.every(([operacao, coluna, valor]) => {
        if (operacao === "eq") return linha[coluna] === valor;
        if (operacao === "is") return (linha[coluna] ?? null) === valor;
        return (valor as unknown[]).includes(linha[coluna]);
      }),
    );
    // A ordem do PostgREST é a última declarada primeiro; aqui basta o desempate
    // por prazo (nulo por último), que é o que o menu herda.
    for (const { coluna, ascendente } of [...ordens].reverse()) {
      saida = [...saida].sort((a, b) => {
        const va = a[coluna] as string | null;
        const vb = b[coluna] as string | null;
        if (va === vb) return 0;
        if (va === null) return ascendente ? 1 : -1;
        if (vb === null) return ascendente ? -1 : 1;
        return (va < vb ? -1 : 1) * (ascendente ? 1 : -1);
      });
    }
    return Promise.resolve({ data: saida.slice(0, teto), error: null }).then(res);
  };
  vi.mocked(createClient).mockResolvedValue({ from: () => elo } as never);
}

describe("sonda do contador no menu — caso x esperado x obtido", () => {
  const OUTRO = "44444444-4444-4444-8444-444444444444";
  const LINHAS = [
    { id: "minha-pendente", status: "pending", assigned_to: ANA, organization_id: ORG },
    { id: "minha-em-andamento", status: "in_progress", assigned_to: ANA, organization_id: ORG },
    { id: "minha-concluida", status: "done", assigned_to: ANA, organization_id: ORG },
    { id: "do-colega", status: "pending", assigned_to: OUTRO, organization_id: ORG },
    { id: "de-outra-organizacao", status: "pending", assigned_to: ANA, organization_id: OUTRA_ORG },
  ];

  it.each(["agent", "manager", "admin"] as const)(
    "papel %s: devolve as 2 próprias em aberto — não a concluída, não a do colega, não a de outra org",
    async (papel) => {
      sessao(papel);
      fazerSupabaseSobre(LINHAS);
      const { GET } = await import("@/app/api/v1/tasks/route");

      const res = await GET(new NextRequest("http://x/api/v1/tasks?aberto=true&assigned_to=me"));

      expect(res.status).toBe(200);
      const corpo = (await res.json()) as { data: { tasks: Array<{ id: string }> } };
      expect(corpo.data.tasks.map((t) => t.id).sort()).toEqual([
        "minha-em-andamento",
        "minha-pendente",
      ]);
    },
  );
});
