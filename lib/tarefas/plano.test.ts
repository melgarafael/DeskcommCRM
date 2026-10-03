import { describe, expect, it, vi } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

import { aplicarPlanoDeTarefas, lePlanosDoSettings } from "./plano";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
// Push de verdade gravaria em `web_push_subscriptions` no meio do teste.
vi.mock("@/lib/notifications/web_push", () => ({
  enviarPushAoUsuario: vi.fn(async () => undefined),
}));

/**
 * PLANOS DE TAREFA (#1752) — a sequência reutilizável.
 *
 * O que este arquivo vigia é o critério de aceite da proposta, medido:
 *
 *   1. aplicar um plano de 3 passos cria 3 tarefas, NA ORDEM declarada, com o
 *      prazo relativo (`vence_em_dias` a partir do relógio fixado) e o
 *      responsável já resolvido;
 *   2. reaplicar o MESMO plano ao MESMO negócio não duplica — a segunda
 *      chamada devolve `ja_aplicado` e não escreve linha nova;
 *   3. plano inexistente é recusa de configuração (`plano_nao_encontrado`),
 *      não exceção nem INSERT órfão.
 *
 * O banco é falso no MESMO molde de `criar-tarefa.test.ts`: a cadeia do
 * supabase que os dois percorrem, sem PostgREST. O que importa aqui é a
 * ORDEM das escritas em `crm_tasks` e o fato de a 2ª aplicação não acrescentar
 * nenhuma.
 */

type Linha = Record<string, unknown>;

const ORG = "aaaaaaaa-0000-4000-8000-00000000000a";
const LEAD = "bbbbbbbb-0000-4000-8000-00000000000b";
const DONO = "99999999-0000-4000-8000-000000000009";
const OUTRO = "77777777-0000-4000-8000-000000000007";
const PLANO = "plano-proposta-enviada";

const AGORA = new Date("2026-10-01T12:00:00.000Z");

const PLANO_3_PASSOS = {
  id: PLANO,
  nome: "Proposta enviada",
  descricao: "Sequência de retorno da proposta comercial",
  passos: [
    {
      ordem: 1,
      titulo: "Agradecer a proposta de {{lead.title}}",
      vence_em_dias: 0,
      prioridade: "high",
      atribuir_a: "dono_do_lead",
    },
    {
      ordem: 2,
      titulo: "Ligar para conferir o recebimento",
      vence_em_dias: 2,
      prioridade: "medium",
      atribuir_a: "dono_do_lead",
    },
    {
      ordem: 3,
      titulo: "Enviar o caso de sucesso",
      vence_em_dias: 5,
      prioridade: "low",
      atribuir_a: { usuario_id: OUTRO },
    },
  ],
};

/** A cadeia do supabase que o módulo percorre, sem PostgREST. */
class Cadeia {
  private inserido: Linha | null = null;
  private readonly filtros: Array<[string, unknown]> = [];
  private limite: number | null = null;

  constructor(
    private readonly db: DbFalso,
    private readonly tabela: string,
  ) {}

  select(): this {
    return this;
  }
  eq(coluna: string, valor: unknown): this {
    this.filtros.push([coluna, valor]);
    return this;
  }
  limit(n: number): this {
    this.limite = n;
    return this;
  }
  insert(dados: Linha): this {
    this.inserido = dados;
    this.db.escritas.push({ tabela: this.tabela, dados });
    return this;
  }
  /** O INSERT devolve a linha gravada com o id que o banco teria dado. */
  async maybeSingle(): Promise<{ data: Linha | null; error: null }> {
    if (this.inserido) return { data: { ...this.inserido, id: this.db.proximoId() }, error: null };
    return { data: this.selecionadas()[0] ?? null, error: null };
  }
  /** Leitura em lote: `await db.from(...).select(...).eq(...).limit(n)`. */
  then<TResult>(
    onfulfilled?: ((v: { data: Linha[]; error: null }) => TResult | PromiseLike<TResult>) | null,
  ): PromiseLike<TResult> {
    return Promise.resolve({ data: this.selecionadas(), error: null }).then(
      onfulfilled ?? ((v) => v as unknown as TResult),
    );
  }
  private selecionadas(): Linha[] {
    const linhas = this.db
      .linhas(this.tabela)
      .filter((linha) => this.filtros.every(([coluna, valor]) => linha[coluna] === valor));
    return this.limite === null ? linhas : linhas.slice(0, this.limite);
  }
}

class DbFalso {
  readonly escritas: Array<{ tabela: string; dados: Linha }> = [];
  private sequencia = 0;

  constructor(private readonly tabelas: Record<string, Linha[]>) {}

  linhas(tabela: string): Linha[] {
    return this.tabelas[tabela] ?? [];
  }
  proximoId(): string {
    this.sequencia += 1;
    return `00000000-0000-4000-8000-0000000000${this.sequencia}`;
  }
  from(tabela: string): Cadeia {
    return new Cadeia(this, tabela);
  }
  tarefasInseridas(): Linha[] {
    return this.escritas.filter((e) => e.tabela === "crm_tasks").map((e) => e.dados);
  }
}

function dbCom(opcoes: { settings?: unknown; aplicacoes?: Linha[] } = {}): DbFalso {
  return new DbFalso({
    organizations: [
      {
        id: ORG,
        settings: opcoes.settings ?? { task_plans: [PLANO_3_PASSOS] },
      },
    ],
    crm_leads: [
      {
        id: LEAD,
        organization_id: ORG,
        title: "Renovação do contrato",
        contact_id: null,
        owner_user_id: DONO,
      },
    ],
    contacts: [],
    crm_tasks: [],
    crm_lead_activities: opcoes.aplicacoes ?? [],
  });
}

async function aplicar(db: DbFalso) {
  return aplicarPlanoDeTarefas(db as unknown as SupabaseClient, {
    organizationId: ORG,
    leadId: LEAD,
    planoId: PLANO,
    origem: "automation:regra-1",
    agora: AGORA,
  });
}

describe("aplicarPlanoDeTarefas", () => {
  it("⭐ cria as 3 tarefas na ordem declarada, com prazo relativo e responsável resolvido", async () => {
    const db = dbCom();

    const resultado = await aplicar(db);

    expect(resultado).toEqual({
      ok: true,
      ja_aplicado: false,
      tarefa_ids: expect.arrayContaining([expect.any(String)]),
    });
    const tarefas = db.tarefasInseridas();
    expect(tarefas.map((t) => t.title)).toEqual([
      "Agradecer a proposta de Renovação do contrato",
      "Ligar para conferir o recebimento",
      "Enviar o caso de sucesso",
    ]);
    // O prazo é RELATIVO à aplicação: 0, 2 e 5 dias a partir do relógio fixado.
    expect(tarefas.map((t) => t.due_date)).toEqual([
      AGORA.toISOString(),
      new Date(AGORA.getTime() + 2 * 86_400_000).toISOString(),
      new Date(AGORA.getTime() + 5 * 86_400_000).toISOString(),
    ]);
    // `dono_do_lead` resolve no dono do negócio; `{ usuario_id }` passa direto.
    expect(tarefas.map((t) => t.assigned_to)).toEqual([DONO, DONO, OUTRO]);
    expect(tarefas.every((t) => t.lead_id === LEAD && t.status === "pending")).toBe(true);
    // A ordem declarada é a ordem da escrita — nada de paralelizar e reordenar.
    expect(tarefas.map((t) => t.priority)).toEqual(["high", "medium", "low"]);
  });

  it("⭐ reaplicar o mesmo plano ao mesmo negócio não duplica", async () => {
    const db = dbCom({
      aplicacoes: [
        {
          organization_id: ORG,
          lead_id: LEAD,
          type: "task_plan_applied",
          payload: { plano_id: PLANO },
        },
      ],
    });

    const resultado = await aplicar(db);

    expect(resultado).toEqual({ ok: true, ja_aplicado: true, tarefa_ids: [] });
    expect(db.tarefasInseridas()).toHaveLength(0);
  });

  it("grava a aplicação na linha do tempo do negócio (a prova que a 2ª leitura usa)", async () => {
    const db = dbCom();

    await aplicar(db);

    const aplicacoes = db.escritas.filter((e) => e.tabela === "crm_lead_activities");
    const marca = aplicacoes.find((a) => a.dados.type === "task_plan_applied");
    expect(marca).toBeDefined();
    expect(marca!.dados.lead_id).toBe(LEAD);
    expect(marca!.dados.payload).toMatchObject({ plano_id: PLANO, passos: 3 });
  });

  it("plano desconhecido é recusa de configuração e não escreve tarefa nenhuma", async () => {
    const db = dbCom();

    const resultado = await aplicarPlanoDeTarefas(db as unknown as SupabaseClient, {
      organizationId: ORG,
      leadId: LEAD,
      planoId: "nao-existe",
      origem: "automation:regra-1",
      agora: AGORA,
    });

    expect(resultado).toEqual({ ok: false, codigo: "plano_nao_encontrado" });
    expect(db.tarefasInseridas()).toHaveLength(0);
  });

  it("sem negócio não há onde aplicar — `sem_alvo`, sem INSERT", async () => {
    const db = dbCom();

    const resultado = await aplicarPlanoDeTarefas(db as unknown as SupabaseClient, {
      organizationId: ORG,
      leadId: null,
      planoId: PLANO,
      origem: "automation:regra-1",
      agora: AGORA,
    });

    expect(resultado).toEqual({ ok: false, codigo: "sem_alvo" });
    expect(db.tarefasInseridas()).toHaveLength(0);
  });
});

describe("lePlanosDoSettings", () => {
  it("lê a lista gravada em organizations.settings.task_plans e ignora o que for torto", () => {
    const planos = lePlanosDoSettings({
      task_plans: [
        PLANO_3_PASSOS,
        { nome: "Sem id", passos: [] },
        "não é um plano",
        { id: "ok", nome: "Simples", passos: [{ titulo: "Único", vence_em_dias: 1 }] },
      ],
    });

    expect(planos.map((p) => p.id)).toEqual([PLANO, "ok"]);
    // Passo sem `ordem` ganha a posição dele na lista — a ordem é lida, não improvisada.
    expect(planos[0]?.passos.map((p) => p.ordem)).toEqual([1, 2, 3]);
    expect(planos[1]?.passos[0]).toMatchObject({ ordem: 1, prioridade: "medium" });
  });

  it("settings ausente ou inválido devolve lista vazia (nunca lança)", () => {
    expect(lePlanosDoSettings(undefined)).toEqual([]);
    expect(lePlanosDoSettings({ task_plans: "lixo" })).toEqual([]);
    expect(lePlanosDoSettings(null)).toEqual([]);
  });
});
