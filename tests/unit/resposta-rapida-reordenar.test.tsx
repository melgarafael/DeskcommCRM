/**
 * A RESPOSTA RÁPIDA REORDENÁVEL (#3244) — do fio à tela, e de volta ao Inbox.
 *
 * ─── O defeito, medido ──────────────────────────────────────────────────────
 *
 * A listagem (`app/api/v1/message-templates/route.ts`) devolvia as respostas por
 * `updated_at desc` e NÃO existia coluna de ordem em `message_templates` (medido
 * no `origin/main` dc921fa33: `grep -n 'order(' route.ts` → uma linha, e
 * `grep -n ordem supabase/baseline.sql` → nada de templates). Editar o corpo de
 * uma resposta a empurrava para o topo da lista da tela E do slash-menu do
 * Inbox, e não havia como voltar a ordem anterior.
 *
 * ─── O que este arquivo prova ───────────────────────────────────────────────
 *
 *   1. Depois de salvar a reordenação, a LISTAGEM devolve as respostas na
 *      sequência escolhida — a asserção é na ordem do `data`, não na resposta do
 *      PUT: um PUT que devolvesse a linha certa e não gravasse a posição
 *      passaria numa asserção de igualdade de corpo do PUT.
 *   2. Recarregar a tela (uma segunda listagem, sem cache nenhum) mantém a
 *      sequência, que é o que a issue chama de "manter a organização".
 *   3. O slash-menu do INBOX lista na ordem definida: o menu recebe a saída da
 *      listagem de verdade, e é a ordem do DOM que se mede.
 *   4. Reordenar não muda CONTEÚDO: título, corpo, atalho e mídias ficam byte a
 *      byte como estavam — a issue diz "preservar os cadastros".
 *   5. `depois_de` de OUTRA organização é recusado pela régua de posse das mídias
 *      (a lista visível), e o vizinho alheio não é usado para calcular posição.
 *   6. O arrasto da TELA manda o VIZINHO da esquerda, não o índice.
 *   7. Escrita que a RLS recusa não vira sucesso: nem 200, nem audit (P1), e a
 *      renumeração recusa ANTES do primeiro UPDATE (P2) — com o par de controle
 *      do admin, que renumera a lista inteira.
 *   8. A resposta NOVA nasce no topo, sem empate: editar uma resposta nova não
 *      a troca de lugar com outra nova (P3, pelo POST e pelo PATCH reais).
 *
 * O banco é um dublê stateful das duas consultas que a rota faz (a lista
 * visível e a escrita da posição) + o mesmo `order()` encadeado da listagem: é o
 * suficiente para a ordem ser medida de ponta a ponta, sem banco de verdade.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  guard: vi.fn(),
  apoio: vi.fn(),
  audit: vi.fn(),
  /** O papel do chamador — é o que a RLS do dublê usa para deixar (ou não) escrever. */
  papel: { organizacao: "", usuario: "", podeCompartilhado: false },
  /** As linhas da tabela, mutáveis: a listagem e a reordenação leem as MESMAS. */
  linhas: [] as Linha[],
  capturado: { onDragEnd: null as ((r: unknown) => void) | null },
  put: vi.fn(),
  /** A lista que a tela do arrasto enxerga (o `useMessageTemplates` dublado). */
  listaDaTela: [] as MessageTemplate[],
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: h.guard }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: h.apoio }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => banco() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/api/client", () => ({
  apiClient: { put: h.put, get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
// A tela recebe a lista pronta: o que este arquivo mede do arrasto é o que ele
// MANDA no fio (`depois_de`, o vizinho), não o refetch — esse é o (1)-(3).
vi.mock("@/hooks/inbox/useMessageTemplates", async () => {
  const real = await vi.importActual<typeof import("@/hooks/inbox/useMessageTemplates")>(
    "@/hooks/inbox/useMessageTemplates",
  );
  return { ...real, useMessageTemplates: () => ({ data: h.listaDaTela, isLoading: false }) };
});
vi.mock("@hello-pangea/dnd", () => ({
  DragDropContext: ({
    onDragEnd,
    children,
  }: {
    onDragEnd: (r: unknown) => void;
    children: ReactNode;
  }) => {
    h.capturado.onDragEnd = onDragEnd;
    return <div>{children}</div>;
  },
  Droppable: ({ children }: { children: (p: Record<string, unknown>) => ReactNode }) =>
    children({ innerRef: () => {}, droppableProps: {}, placeholder: null }),
  Draggable: ({
    children,
  }: {
    children: (p: Record<string, unknown>, s: Record<string, unknown>) => ReactNode;
  }) => children({ innerRef: () => {}, draggableProps: {}, dragHandleProps: {} }, { isDragging: false }),
}));

import { GET, POST } from "@/app/api/v1/message-templates/route";
import { PATCH } from "@/app/api/v1/message-templates/[id]/route";
import { PUT } from "@/app/api/v1/message-templates/[id]/ordem/route";
import { TemplateMenu } from "@/components/inbox/composer/TemplateMenu";
import { TemplatesClient } from "@/app/app/templates/_components/TemplatesClient";
import type { MessageTemplate } from "@/hooks/inbox/useMessageTemplates";

const ORG = "b7c30000-0000-4000-8000-000000000001";
const OUTRA_ORG = "b7c30000-0000-4000-8000-0000000000ff";
const USER = "b7c30000-0000-4000-8000-000000000002";

interface Linha {
  id: string;
  organization_id: string;
  owner_user_id: string | null;
  title: string;
  body: string;
  shortcut: string | null;
  midias: unknown[];
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
  ordem: number;
}

/**
 * Uma linha de `message_templates`. `ordem` 0 é o topo (o `default` que a
 * resposta nova herda); os empates são desempatados por `updated_at desc`, como
 * na listagem.
 */
function linha(id: string, ordem: number, extra: Partial<Linha> = {}): Linha {
  return {
    id,
    organization_id: ORG,
    owner_user_id: USER,
    title: `Título ${id}`,
    body: `Corpo ${id}`,
    shortcut: `s${id}`,
    midias: [],
    created_by_user_id: USER,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    ordem,
    ...extra,
  };
}

/**
 * O dublê do PostgREST: o MESMO `select/eq/order/limit/maybeSingle`, o mesmo
 * `update(...).eq(...).select(...).maybeSingle()` e o `insert(...).select().single()`
 * que as rotas usam, com a RLS de `message_templates` (todo membro lê
 * compartilhado + próprio; escreve o próprio com `agent`, e o compartilhado só
 * com manager+).
 *
 * Cada `from()` abre uma consulta NOVA, como o supabase-js: filtros, patch e
 * colunas de uma consulta não vazam para a seguinte. (A versão anterior
 * reaproveitava um builder só e acumulava os `eq()` — a 2ª escrita de uma
 * renumeração herdava o `id` da 1ª e não casava nada, então todo empate dava
 * 409, até para admin.)
 */
function banco() {
  const visivel = (l: Linha) =>
    l.organization_id === h.papel.organizacao &&
    (l.owner_user_id === null || l.owner_user_id === h.papel.usuario);

  const escrevivel = (l: Linha) =>
    l.organization_id === h.papel.organizacao &&
    (l.owner_user_id === h.papel.usuario ||
      (l.owner_user_id === null && h.papel.podeCompartilhado));

  function consulta() {
    const filtros: Array<[string, unknown]> = [];
    const ordem: Array<[string, boolean]> = [];
    let patch: Record<string, unknown> | null = null;
    let novo: Record<string, unknown> | null = null;
    let colunasDeVolta = "id";
    let teto = Number.POSITIVE_INFINITY;

    const casam = (base: Linha[]) =>
      base.filter((l) => filtros.every(([coluna, valor]) => l[coluna as keyof Linha] === valor));

    /** O efeito da consulta: escrita (insert/update) ou leitura ordenada. */
    const executar = (): Array<Record<string, unknown>> => {
      if (novo) {
        const criada = linha(`n${h.linhas.length + 1}`, 0, {
          updated_at: new Date().toISOString(),
          ...(novo as Partial<Linha>),
        });
        if (!escrevivel(criada)) return [];
        h.linhas.push(criada);
        return [somente(criada, colunasDeVolta)];
      }
      if (patch) {
        const alvos = casam(h.linhas).filter(escrevivel);
        for (const alvo of alvos) Object.assign(alvo, patch);
        return alvos.map((l) => somente(l, colunasDeVolta));
      }
      const lista = casam(h.linhas.filter(visivel));
      lista.sort((a, b) => {
        for (const [coluna, ascendente] of ordem) {
          const x = a[coluna as keyof Linha] as never;
          const y = b[coluna as keyof Linha] as never;
          if (x === y) continue;
          return ascendente ? (x < y ? -1 : 1) : x < y ? 1 : -1;
        }
        return 0;
      });
      return lista.slice(0, teto).map((l) => somente(l, colunasDeVolta));
    };

    const builder = {
      select: (colunas?: string) => {
        if (colunas) colunasDeVolta = colunas;
        return builder;
      },
      eq: (coluna: string, valor: unknown) => {
        filtros.push([coluna, valor]);
        return builder;
      },
      update: (valores: Record<string, unknown>) => {
        patch = valores;
        return builder;
      },
      insert: (valores: Record<string, unknown>) => {
        novo = valores;
        return builder;
      },
      order: (coluna: string, opcoes?: { ascending?: boolean }) => {
        ordem.push([coluna, opcoes?.ascending ?? true]);
        return builder;
      },
      limit: (n: number) => {
        teto = n;
        return builder;
      },
      maybeSingle: async () => ({ data: executar()[0] ?? null, error: null }),
      single: async () => {
        const primeira = executar()[0];
        return primeira
          ? { data: primeira, error: null }
          : { data: null, error: { code: "PGRST116", message: "no rows" } };
      },
      then: (aoResolver?: ((v: unknown) => unknown) | null) =>
        Promise.resolve({ data: executar(), error: null }).then(aoResolver ?? ((v) => v)),
    };
    return builder;
  }

  return { from: (_tabela: string) => consulta() };
}

/** O que a coluna pedida devolve — `"id"` responde só o id, como o `select` da rota. */
function somente(l: Linha, colunas: string): Record<string, unknown> {
  if (colunas.trim() === "id") return { id: l.id };
  const pedidas = colunas.split(",").map((c) => c.trim());
  const saida: Record<string, unknown> = {};
  for (const coluna of pedidas) saida[coluna] = l[coluna as keyof Linha];
  return saida;
}

function requisicao(corpo: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/v1/message-templates/x/ordem`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(corpo),
  });
}

const parametros = (id: string) => ({ params: Promise.resolve({ id }) });

/** A listagem de verdade, pelo handler do App Router. */
async function listar(): Promise<MessageTemplate[]> {
  const resposta = await GET(new NextRequest("http://localhost/api/v1/message-templates"));
  const corpo = (await resposta.json()) as { data: MessageTemplate[] };
  return corpo.data;
}

beforeEach(() => {
  vi.resetAllMocks();
  h.papel = { organizacao: ORG, usuario: USER, podeCompartilhado: true };
  h.capturado.onDragEnd = null;
  h.guard.mockResolvedValue({
    ok: true,
    user: { id: USER, idioma: "pt" },
    org: { orgId: ORG, role: "manager" },
  });
  h.apoio.mockResolvedValue(null);
});

describe("a listagem sai na ordem do operador, não na de edição", () => {
  it("(1) reordenar salva a sequência: a listagem devolve a ordem escolhida", async () => {
    // A resposta `c` foi EDITADA por último (updated_at mais novo) e é a que a
    // listagem de ANTES trazia em primeiro; depois da reordenação ela vai para o
    // fim, e quem manda é `ordem` — não a data.
    h.linhas = [
      linha("a", 1000, { updated_at: "2026-10-01T10:00:00.000Z" }),
      linha("b", 2000, { updated_at: "2026-10-01T11:00:00.000Z" }),
      linha("c", 3000, { updated_at: "2026-10-01T12:00:00.000Z" }),
    ];
    expect((await listar()).map((t) => t.id)).toEqual(["a", "b", "c"]);

    // O operador solta `a` no fim: `depois_de` = o vizinho da esquerda (`c`).
    const resposta = await PUT(requisicao({ depois_de: "c" }), parametros("a"));
    expect(resposta.status).toBe(200);

    expect((await listar()).map((t) => t.id)).toEqual(["b", "c", "a"]);
    // A prova de que a ordem é a coluna, e não a data: `c` continua o mais
    // recentemente editado e mesmo assim está no meio.
    expect(h.linhas.find((l) => l.id === "c")!.updated_at).toBe("2026-10-01T12:00:00.000Z");
  });

  it("(2) recarregar a tela mantém a sequência (a segunda listagem é a mesma)", async () => {
    h.linhas = [linha("a", 1000), linha("b", 2000), linha("c", 3000)];
    await PUT(requisicao({ depois_de: null }), parametros("c"));

    // "Recarregar" = uma leitura nova, sem cache nenhum: as duas listagens
    // concordam porque a ordem mora na LINHA, não na memória da tela.
    const primeira = (await listar()).map((t) => t.id);
    const segunda = (await listar()).map((t) => t.id);
    expect(primeira).toEqual(["c", "a", "b"]);
    expect(segunda).toEqual(["c", "a", "b"]);
  });

  it("(3) o slash-menu do Inbox lista na ordem definida", async () => {
    h.linhas = [linha("a", 1000), linha("b", 2000), linha("c", 3000)];
    await PUT(requisicao({ depois_de: null }), parametros("c"));

    // O menu recebe a saída da LISTAGEM — é o mesmo caminho do Composer
    // (`useMessageTemplates` → `TemplateMenu`), sem ordenação própria.
    const templates = await listar();
    render(
      <TemplateMenu open query="" templates={templates} onPick={() => {}} onClose={() => {}} />,
    );

    const titulos = screen
      .getAllByRole("button")
      .map((botao) => botao.querySelector("span")?.textContent ?? "")
      .filter((texto) => texto.startsWith("Título "));
    expect(titulos).toEqual(["Título c", "Título a", "Título b"]);
  });

  it("(4) reordenar não muda conteúdo: título, corpo, atalho e mídias intactos", async () => {
    const comMidia = linha("a", 1000, {
      midias: [{ storage_path: `${ORG}/templates/a/x.png`, media_mime: "image/png", media_size_bytes: 10 }],
    });
    h.linhas = [comMidia, linha("b", 2000)];
    const antes = structuredClone(comMidia);

    await PUT(requisicao({ depois_de: "b" }), parametros("a"));

    const depois = h.linhas.find((l) => l.id === "a")!;
    expect(depois).toMatchObject({
      title: antes.title,
      body: antes.body,
      shortcut: antes.shortcut,
      midias: antes.midias,
      updated_at: antes.updated_at,
    });
    expect(depois.ordem).not.toBe(antes.ordem);
  });

  it("(5) recusa vizinho de OUTRA organização (a régua de posse das mídias)", async () => {
    h.linhas = [linha("a", 1000), linha("alheia", 2000, { organization_id: OUTRA_ORG })];

    const resposta = await PUT(requisicao({ depois_de: "alheia" }), parametros("a"));

    expect(resposta.status).toBe(422);
    expect((await resposta.json()).error.code).toBe("validation_failed");
    // Nada foi escrito: a posição de `a` continua a de antes.
    expect(h.linhas.find((l) => l.id === "a")!.ordem).toBe(1000);
  });

  it("(5b) recusa reordenar resposta que este papel não vê", async () => {
    h.papel = { organizacao: ORG, usuario: USER, podeCompartilhado: false };
    h.linhas = [linha("a", 1000), linha("de-outro", 2000, { owner_user_id: "outro-usuario" })];

    const resposta = await PUT(requisicao({ depois_de: null }), parametros("de-outro"));

    expect(resposta.status).toBe(404);
  });
});

describe("a escrita que a RLS recusa não vira sucesso", () => {
  /** Um `agent`: escreve só as próprias; a compartilhada é de manager+. */
  function comoAgente() {
    h.papel = { organizacao: ORG, usuario: USER, podeCompartilhado: false };
    h.guard.mockResolvedValue({
      ok: true,
      user: { id: USER, idioma: "pt" },
      org: { orgId: ORG, role: "agent" },
    });
  }

  /** As três em `0` — empate, o caminho da renumeração. */
  const empatadas = () => [
    linha("p1", 0, { updated_at: "2026-10-01T12:00:00.000Z" }),
    linha("s", 0, { owner_user_id: null, updated_at: "2026-10-01T11:00:00.000Z" }),
    linha("p2", 0, { updated_at: "2026-10-01T10:00:00.000Z" }),
  ];
  const ordens = () => Object.fromEntries(h.linhas.map((l) => [l.id, l.ordem]));

  it("(P1) agent movendo resposta COMPARTILHADA: 403, sem audit e com a ordem intacta", async () => {
    comoAgente();
    h.linhas = [linha("a", 1000), linha("s", 2000, { owner_user_id: null })];

    const resposta = await PUT(requisicao({ depois_de: null }), parametros("s"));

    expect(resposta.status).toBe(403);
    expect((await resposta.json()).error.code).toBe("forbidden");
    expect(h.audit).not.toHaveBeenCalled();
    expect(ordens()).toEqual({ a: 1000, s: 2000 });
  });

  it("(P2, controle) admin com empate renumera a lista INTEIRA na ordem pedida", async () => {
    h.linhas = empatadas();

    // Soltar p2 logo depois de p1: [p1, p2, s].
    const resposta = await PUT(requisicao({ depois_de: "p1" }), parametros("p2"));

    expect(resposta.status).toBe(200);
    expect(ordens()).toEqual({ p1: 1000, p2: 2000, s: 3000 });
    expect((await listar()).map((t) => t.id)).toEqual(["p1", "p2", "s"]);
  });

  it("(P2) agent com compartilhada na lista: 409 sem NENHUMA linha escrita", async () => {
    comoAgente();
    h.linhas = empatadas();

    const resposta = await PUT(requisicao({ depois_de: "p1" }), parametros("p2"));

    expect(resposta.status).toBe(409);
    expect(ordens()).toEqual({ p1: 0, s: 0, p2: 0 });
    expect(h.audit).not.toHaveBeenCalled();
  });
});

describe("a resposta nova nasce no topo, sem empate", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** O POST real da criação, sem `Idempotency-Key`. */
  async function criar(titulo: string): Promise<string> {
    const resposta = await POST(
      new NextRequest("http://localhost/api/v1/message-templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: titulo, body: `Corpo ${titulo}` }),
      }),
    );
    expect(resposta.status).toBe(201);
    return ((await resposta.json()) as { data: { id: string } }).data.id;
  }

  it("(P3) cria D e depois E, edita D: E continua acima de D", async () => {
    // Só o relógio é falso: o `updated_at` de cada passo é um instante distinto.
    vi.useFakeTimers({ toFake: ["Date"] });
    h.linhas = [linha("velha", 1000)];

    vi.setSystemTime(new Date("2026-10-22T10:00:00.000Z"));
    const d = await criar("D");
    expect((await listar()).map((t) => t.id)).toEqual([d, "velha"]);

    vi.setSystemTime(new Date("2026-10-22T11:00:00.000Z"));
    const e = await criar("E");
    expect((await listar()).map((t) => t.id)).toEqual([e, d, "velha"]);

    // O PATCH de conteúdo carimba `updated_at` — e não pode mover D.
    vi.setSystemTime(new Date("2026-10-22T12:00:00.000Z"));
    const editada = await PATCH(
      new NextRequest(`http://localhost/api/v1/message-templates/${d}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: "Corpo novo" }),
      }),
      parametros(d),
    );
    expect(editada.status).toBe(200);

    expect((await listar()).map((t) => t.id)).toEqual([e, d, "velha"]);
  });
});

describe("o arrasto da tela", () => {
  const LISTA: MessageTemplate[] = [
    { id: "1", title: "Um", body: "b1", shortcut: null, owner_user_id: USER },
    { id: "2", title: "Dois", body: "b2", shortcut: null, owner_user_id: USER },
    { id: "3", title: "Três", body: "b3", shortcut: null, owner_user_id: USER },
  ];

  /** Monta a tela com a lista que ela enxerga e com o dnd dublado. */
  function montarTela(lista: MessageTemplate[], canShare: boolean) {
    h.listaDaTela = lista;
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <TemplatesClient canShare={canShare} currentUserId={USER} />
      </QueryClientProvider>,
    );
  }

  beforeEach(() => {
    h.put.mockResolvedValue({ data: { id: "1" } });
  });

  it("(6) soltar na primeira posição manda `depois_de: null`", async () => {
    montarTela(LISTA, true);
    await waitFor(() => expect(h.capturado.onDragEnd).not.toBeNull());

    await act(async () => {
      h.capturado.onDragEnd?.({
        draggableId: "3",
        source: { droppableId: "respostas-rapidas", index: 2 },
        destination: { droppableId: "respostas-rapidas", index: 0 },
        reason: "DROP",
        type: "DEFAULT",
        mode: "FLUID",
      });
    });

    await waitFor(() =>
      expect(h.put).toHaveBeenCalledWith("/api/v1/message-templates/3/ordem", { depois_de: null }),
    );
  });

  it("(7) soltar no meio manda o VIZINHO da esquerda, não o índice", async () => {
    montarTela(LISTA, true);
    await waitFor(() => expect(h.capturado.onDragEnd).not.toBeNull());

    await act(async () => {
      h.capturado.onDragEnd?.({
        draggableId: "1",
        source: { droppableId: "respostas-rapidas", index: 0 },
        destination: { droppableId: "respostas-rapidas", index: 2 },
        reason: "DROP",
        type: "DEFAULT",
        mode: "FLUID",
      });
    });

    await waitFor(() =>
      expect(h.put).toHaveBeenCalledWith("/api/v1/message-templates/1/ordem", { depois_de: "3" }),
    );
  });

  it("(8) a alça de arrastar só existe no que este papel pode reordenar", () => {
    montarTela(
      [
        LISTA[0]!,
        { id: "9", title: "Da equipe", body: "b", shortcut: null, owner_user_id: null },
      ],
      false,
    );

    expect(screen.getAllByLabelText("Arrastar para reordenar")).toHaveLength(1);
  });
});
