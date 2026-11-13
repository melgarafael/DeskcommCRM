import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { HandlerCtx } from "@/lib/api/handlers/types";

/**
 * A LEITURA DA SITUAÇÃO ANTERIOR QUE FALHA NÃO PODE SER LIDA COMO "NÃO HAVIA
 * ANTES".
 *
 * ─── O que estava quebrado ────────────────────────────────────────────────
 *
 * `editarTarefaHandler` fazia `const { data: antes } = await supabase …` e
 * ignorava o `error`. Quando a consulta falhava, `antes` vinha `null` — o que o
 * código lia como "a tarefa não tinha situação", exatamente o mesmo valor que
 * uma tarefa já concluída produz. A edição seguia, `fechouAgora` dava
 * verdadeiro e o negócio ganhava OUTRA linha `task_completed` na timeline; o
 * audit gravava `de: null`.
 *
 * A main consertou isso na rota (`1a9bb42465`, `.changes/tarefas-leitura-do-
 * estado.md`): leitura falhou → 500 antes de gravar. Este PR tirou a regra da
 * rota (#4516), então o conserto precisa morar no HANDLER — senão o merge da
 * rota fina apaga o `1a9bb42465` e a suíte inteira continua verde.
 *
 * ─── O que este arquivo prova ─────────────────────────────────────────────
 *
 *  1. leitura da situação anterior falhando → 500 `internal_error`, NADA é
 *     gravado: sem UPDATE, sem audit e sem linha na timeline;
 *  2. a edição normal continua ACHANDO o status anterior — o 500 não pode ter
 *     sido comprado com a leitura cega.
 *
 * Os dois caminhos (tela e token) chamam o MESMO handler; o ator aqui é o de
 * token e o de sessão aparece no segundo caso, para a régua não depender de
 * quem entrou.
 */
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/tarefas/atividade", () => ({
  registraAtividadeDaTarefa: vi.fn(async () => undefined),
}));
vi.mock("@/lib/tarefas/responsavel", () => ({
  conferirResponsavel: vi.fn(async () => "ok"),
}));
vi.mock("@/lib/tarefas/demanda", () => ({
  conferirDemanda: vi.fn(async () => "ok"),
}));
vi.mock("@/lib/db", () => ({ portaDaAplicacao: () => ({ fake: true }) }));

const { editarTarefaHandler } = await import("@/app/api/v1/tasks/_handler");
const { ApiError } = await import("@/lib/api/types");
const { audit } = await import("@/lib/audit");
const { registraAtividadeDaTarefa } = await import("@/lib/tarefas/atividade");

const ORG = "aaaaaaaa-4523-4000-8000-00000000000a";
const OUTRA_ORG = "bbbbbbbb-4523-4000-8000-00000000000b";
const USER = "cccccccc-4523-4000-8000-00000000000c";
const TOKEN = "dddddddd-4523-4000-8000-00000000000d";
const TAREFA = "eeeeeeee-4523-4000-8000-00000000000e";

type Linha = Record<string, unknown>;

/**
 * Dublê de banco com UM comportamento a mais que o usual: o `select("status")`
 * da situação anterior pode FALHAR. É o único jeito de exercitar o caminho do
 * `erroDaLeitura` sem dublê do handler — e o PostgREST devolve `{data: null,
 * error}` nesse caso, que é justamente a combinação que o defeito lia como
 * "não havia antes".
 */
function banco(opcoes: { falhaNaLeitura: boolean; status?: string }) {
  const linhas: Linha[] = [
    {
      id: TAREFA,
      organization_id: ORG,
      status: opcoes.status ?? "pending",
      title: "Antes da edição",
      description: null,
      due_date: null,
      priority: "medium",
      lead_id: null,
      contact_id: null,
      demanda_id: null,
      assigned_to: null,
      created_by: USER,
    },
    // A linha da outra casa existe para o filtro de organização ter o que
    // excluir — sem ela, um `select` sem `organization_id` passaria igual.
    { id: TAREFA, organization_id: OUTRA_ORG, status: "pending", title: "da outra" },
  ];
  const estado = { updates: 0, leituras: 0 };

  const cliente = {
    from: (tabela: string) => {
      if (tabela !== "crm_tasks") throw new Error(`tabela inesperada: ${tabela}`);
      return {
        select: (colunas?: string) => {
          if (colunas !== "status") throw new Error(`select inesperado: ${colunas}`);
          const filtros: [string, unknown][] = [];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const cadeia: any = {};
          cadeia.eq = (coluna: string, valor: unknown) => {
            filtros.push([coluna, valor]);
            return cadeia;
          };
          cadeia.maybeSingle = async () => {
            estado.leituras += 1;
            if (opcoes.falhaNaLeitura) {
              return { data: null, error: { code: "PGRST000", message: "read failed" } };
            }
            const achada = linhas.find(
              (l) => l.organization_id === ORG && filtros.every(([c, v]) => l[c] === v),
            );
            return { data: achada === undefined ? null : { status: achada.status }, error: null };
          };
          return cadeia;
        },
        update: (payload: Linha) => {
          const filtros: [string, unknown][] = [];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const cadeia: any = {};
          cadeia.eq = (coluna: string, valor: unknown) => {
            filtros.push([coluna, valor]);
            if (coluna === "organization_id" && valor !== ORG) {
              throw new Error("update sem a organização do ctx");
            }
            return cadeia;
          };
          cadeia.select = () => cadeia;
          cadeia.single = async () => {
            const achada = linhas.find(
              (l) => l.organization_id === ORG && filtros.every(([c, v]) => l[c] === v),
            );
            if (achada === undefined) return { data: null, error: { code: "PGRST116" } };
            estado.updates += 1;
            Object.assign(achada, payload);
            return { data: { ...achada }, error: null };
          };
          return cadeia;
        },
      };
    },
  };

  return { cliente: cliente as unknown as SupabaseClient, linhas, estado };
}

const ctxDoToken = {
  organization_id: ORG,
  actor: { type: "api_token", id: TOKEN, organization_id: ORG },
  requestId: "req-4523",
  apiTokenId: TOKEN,
} as unknown as HandlerCtx;

const ctxDaPessoa = {
  organization_id: ORG,
  actor: { type: "user", id: USER, role: "agent" },
  requestId: "req-4523",
} as unknown as HandlerCtx;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("edição de tarefa — leitura da situação anterior", () => {
  it("leitura falhando → 500 `internal_error`, nenhum UPDATE e nenhuma linha na timeline", async () => {
    const { cliente, estado } = banco({ falhaNaLeitura: true });

    const erro = await editarTarefaHandler(cliente, ctxDoToken, {
      id: TAREFA,
      status: "done",
    }).catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(ApiError);
    expect((erro as InstanceType<typeof ApiError>).status).toBe(500);
    expect((erro as InstanceType<typeof ApiError>).code).toBe("internal_error");

    // O ponto do conserto: sem saber a situação ANTERIOR, não se grava nada.
    // Com `antes` nulo a edição seguia e o negócio recebia uma conclusão FALSA.
    expect(estado.updates).toBe(0);
    expect(registraAtividadeDaTarefa).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("edição normal continua achando o status anterior — a transição é pending → done", async () => {
    const { cliente, estado } = banco({ falhaNaLeitura: false, status: "pending" });

    const { task } = await editarTarefaHandler(cliente, ctxDaPessoa, {
      id: TAREFA,
      status: "done",
    });

    expect(task.status).toBe("done");
    expect(estado.updates).toBe(1);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "crm_task.updated",
        metadata: expect.objectContaining({ de: "pending", para: "done" }),
      }),
    );
    // Fechou AGORA: uma linha na timeline, porque a anterior foi lida.
    expect(registraAtividadeDaTarefa).toHaveBeenCalledTimes(1);
    expect(registraAtividadeDaTarefa).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tipo: "task_completed" }),
    );
  });

  it("editar tarefa JÁ concluída não emite segunda linha na timeline", async () => {
    const { cliente } = banco({ falhaNaLeitura: false, status: "done" });

    await editarTarefaHandler(cliente, ctxDoToken, { id: TAREFA, title: "só o título" });

    expect(registraAtividadeDaTarefa).not.toHaveBeenCalled();
  });
});
