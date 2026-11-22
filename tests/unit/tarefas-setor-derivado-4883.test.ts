import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { HandlerCtx } from "@/lib/api/handlers/types";

/**
 * O SELO DE SETOR VEM DA CONVERSA, E O FILTRO CASA COM O SELO (#4883).
 *
 * ─── O defeito que este arquivo tranca ────────────────────────────────────
 *
 * Antes do #4883 o "setor da tarefa" era o setor de QUEM TEM a tarefa
 * (`crm_tasks.assigned_to` → `attendant_sector_members`). Dois efeitos:
 *
 *  • o selo do chip mostrava `sector_ids[0]` do responsável, então quem atende
 *    dois setores via TODAS as tarefas com o mesmo selo — mesmo quando a
 *    conversa do cliente estava em outro setor;
 *  • o filtro "Setor" respondia pela mesma pergunta errada: a tarefa de um
 *    membro do setor A cuja conversa está no setor B APARECIA ao filtrar por A,
 *    e a de quem não é do setor mas cuja conversa está nele NÃO aparecia.
 *
 * A regra passou a ser DERIVADA — conversa → negócio → responsável
 * (`lib/tarefas/setor-da-tarefa.ts`) — e o porte para o `_handler` (#4523) tem
 * de manter as duas pontas juntas: o `setor` anexado e o filtro que decide com
 * `tarefaNoSetor`, a MESMA função.
 *
 * A prova é o caso invertido de propósito: a tarefa 1 tem `assigned_to` de um
 * membro do setor A mas a conversa no setor B; a tarefa 2 não é do membro mas a
 * conversa está em A. Filtrando por A, só a 2 pode voltar.
 */
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/tarefas/atividade", () => ({
  registraAtividadeDaTarefa: vi.fn(async () => undefined),
}));
vi.mock("@/lib/tarefas/negocio-da-tarefa", () => ({
  COLUNAS_DA_TAREFA: "*",
  anexarNegocioDaTarefa: vi.fn(async (_db: unknown, _org: string, tarefas: unknown[]) => tarefas),
  conferirNegocioEContato: vi.fn(async () => "aceitos"),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
/** O módulo `setores` está LIGADO nesta instalação. */
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: vi.fn(async () => true) }));
/** As três fontes, resolvidas sem banco: o que se mede aqui é a decisão. */
vi.mock("@/lib/tarefas/setores-da-tarefa", () => ({
  lerFontesDoSetor: vi.fn(),
}));

const { listarTarefasHandler } = await import("@/app/api/v1/tasks/_handler");
const { ApiError } = await import("@/lib/api/types");
const { moduloLigado } = await import("@/lib/instalacao/modulos");
const { lerFontesDoSetor } = await import("@/lib/tarefas/setores-da-tarefa");

const ORG = "aaaaaaaa-4883-4000-8000-00000000000a";
const TOKEN = "bbbbbbbb-4883-4000-8000-00000000000b";
const SETOR_A = "11111111-4883-4000-8000-00000000000a";
const SETOR_B = "22222222-4883-4000-8000-00000000000b";
const TAREFA_1 = "33333333-4883-4000-8000-00000000000a";
const TAREFA_2 = "44444444-4883-4000-8000-00000000000b";

const LINHAS = [
  { id: TAREFA_1, organization_id: ORG, title: "Do membro do setor A", status: "pending" },
  { id: TAREFA_2, organization_id: ORG, title: "Da conversa no setor A", status: "pending" },
];

/** Dublê mínimo: a lista é uma leitura só, com `eq/order/limit` encadeados. */
function banco() {
  const cadeia: Record<string, unknown> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const elo: any = cadeia;
  for (const metodo of ["select", "eq", "order", "limit", "is", "in", "gte", "lte"] as const) {
    elo[metodo] = () => elo;
  }
  elo.then = (res: (v: unknown) => unknown) =>
    Promise.resolve({ data: LINHAS, error: null }).then(res);
  return { from: () => elo } as unknown as SupabaseClient;
}

const ctxDoToken = {
  organization_id: ORG,
  actor: { type: "api_token", id: TOKEN, organization_id: ORG },
  requestId: "req-4883",
  apiTokenId: TOKEN,
} as unknown as HandlerCtx;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(moduloLigado).mockResolvedValue(true);
  vi.mocked(lerFontesDoSetor).mockResolvedValue(
    new Map([
      // A tarefa 1 é do MEMBRO do setor A, mas a conversa dela está em B.
      [TAREFA_1, { conversa: SETOR_B, responsavel: SETOR_A }],
      // A tarefa 2 é de quem não é do setor, mas a conversa está em A.
      [TAREFA_2, { conversa: SETOR_A, responsavel: SETOR_B }],
    ]),
  );
});

describe("#4883 — o setor é derivado da conversa, não do responsável", () => {
  it("`com_setor` anexa o setor do SELO (conversa), com a origem declarada", async () => {
    const r = await listarTarefasHandler(banco(), ctxDoToken, { com_setor: true });

    expect(r.tasks).toHaveLength(2);
    expect(r.tasks[0]?.setor).toEqual({ id: SETOR_B, origem: "conversa" });
    expect(r.tasks[1]?.setor).toEqual({ id: SETOR_A, origem: "conversa" });
  });

  it("filtrar por setor casa com o SELO: o membro do setor com conversa em outro setor NÃO entra", async () => {
    const r = await listarTarefasHandler(banco(), ctxDoToken, { sector_id: SETOR_A });

    // A 1 tem `responsavel: SETOR_A`, e mesmo assim fica de fora — é este o
    // defeito do #4883. A 2 entra pelo selo, não pelo responsável.
    expect(r.tasks.map((t) => t.id)).toEqual([TAREFA_2]);
    expect(r.tasks[0]?.setor?.id).toBe(SETOR_A);
  });

  it("sem `com_setor` e sem `sector_id` a lista sai como sempre — nenhuma consulta de setor", async () => {
    const r = await listarTarefasHandler(banco(), ctxDoToken, {});

    expect(r.tasks).toHaveLength(2);
    expect(r.tasks[0]?.setor).toBeUndefined();
    expect(lerFontesDoSetor).not.toHaveBeenCalled();
  });

  it("setores DESLIGADO: o filtro responde 404 e o selo sozinho devolve a lista sem ele", async () => {
    vi.mocked(moduloLigado).mockResolvedValue(false);

    const comFiltro = await listarTarefasHandler(banco(), ctxDoToken, { sector_id: SETOR_A }).catch(
      (e: unknown) => e,
    );
    expect(comFiltro).toBeInstanceOf(ApiError);
    expect((comFiltro as InstanceType<typeof ApiError>).status).toBe(404);

    const soSelo = await listarTarefasHandler(banco(), ctxDoToken, { com_setor: true });
    expect(soSelo.tasks.map((t) => t.id)).toEqual([TAREFA_1, TAREFA_2]);
    expect(soSelo.tasks[0]?.setor).toBeUndefined();
  });
});
