import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";

import { criarPorta } from "@/lib/db";
import { registraAtividadeDaTarefa } from "@/lib/tarefas/atividade";
import { criarTarefaInterna } from "@/lib/tarefas/criar-tarefa";
import { conferirDemanda } from "@/lib/tarefas/demanda";
import { aplicarPlanoDeTarefas } from "@/lib/tarefas/plano";
import { conferirResponsavel } from "@/lib/tarefas/responsavel";

/**
 * F1 do #3715 — `lib/tarefas` FALANDO SQL DIRETO, contra Postgres de verdade.
 *
 * O que este arquivo prova, e por que ele não podia ser unitário:
 *
 *   1. as funções migradas gravam e leem o que prometem (tarefa, atividade,
 *      marca de plano, demanda encerrada, régua de responsável);
 *   2. a ORDEM e o PRAZO RELATIVO do plano continuam os mesmos, e reaplicar não
 *      duplica — a idempotência depende de ler a marca gravada em jsonb, coisa
 *      que banco falso nenhum prova;
 *   3. **ISOLAMENTO ENTRE ORGANIZAÇÕES**: com o filtro agora escrito à mão (o
 *      pool não passa por RLS), a organização A não LÊ nem ESCREVE tarefa,
 *      negócio ou demanda da B. É o critério de saída do plano (#3715 §3.3) e
 *      a única razão pela qual esta suíte existe separada da unitária.
 *
 * `audit` e o push são mockados de propósito: eles são efeitos EXTERNOS ao
 * caminho sob teste (fila de eventos e web push), e batê-los de verdade faria
 * o teste medir a rede em vez do SQL.
 */
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/notifications/web_push", () => ({
  enviarPushAoUsuario: vi.fn(async () => undefined),
}));

if (!process.env.TEST_DB_PORT) throw new Error("TEST_DB_PORT ausente — execute pnpm test:db");

const pool = new Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
  max: 4,
});

/** A PORTA de produção (`lib/db`) apontada para o banco efêmero. */
const db = criarPorta(pool);

afterAll(async () => {
  await pool.end();
});

// ── Fixtures ────────────────────────────────────────────────────────────────
const ORG_A = "e3715000-0000-4000-8000-00000000000a";
const ORG_B = "e3715000-0000-4000-8000-00000000000b";

const DONO_A = "e3715000-0000-4000-8000-000000000101";
const VIEWER_A = "e3715000-0000-4000-8000-000000000102";
const REVOGADO_A = "e3715000-0000-4000-8000-000000000103";
const USER_B = "e3715000-0000-4000-8000-000000000201";

const FUNIL_A = "e3715000-0000-4000-8000-000000000301";
const ETAPA_A = "e3715000-0000-4000-8000-000000000302";
const FUNIL_B = "e3715000-0000-4000-8000-000000000311";
const ETAPA_B = "e3715000-0000-4000-8000-000000000312";

const CONTATO_A = "e3715000-0000-4000-8000-000000000401";
const CONTATO_SEM_NOME_A = "e3715000-0000-4000-8000-000000000402";
const CONTATO_B = "e3715000-0000-4000-8000-000000000403";

const LEAD_A = "e3715000-0000-4000-8000-000000000501";
const LEAD_SEM_DONO_A = "e3715000-0000-4000-8000-000000000502";
const LEAD_SEM_NOME_A = "e3715000-0000-4000-8000-000000000503";
const LEAD_B = "e3715000-0000-4000-8000-000000000504";

const DEMANDA_ABERTA_A = "e3715000-0000-4000-8000-000000000601";
const DEMANDA_FECHADA_A = "e3715000-0000-4000-8000-000000000602";
const DEMANDA_B = "e3715000-0000-4000-8000-000000000603";

const OUTRO = "e3715000-0000-4000-8000-000000000701";

const AGORA = new Date("2026-10-01T12:00:00.000Z");

const PLANO_3_PASSOS = {
  id: "plano-proposta-enviada",
  nome: "Proposta enviada",
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

/** O caso da revisão do #2213: o passo recusável é o SEGUNDO. */
const PLANO_COM_DONO_DEPOIS = {
  id: "plano-dono-depois",
  nome: "Do designado ao dono",
  passos: [
    {
      ordem: 1,
      titulo: "Passo de quem já está designado",
      vence_em_dias: 0,
      atribuir_a: { usuario_id: OUTRO },
    },
    {
      ordem: 2,
      titulo: "Passo do dono do negócio",
      vence_em_dias: 1,
      atribuir_a: "dono_do_lead",
    },
  ],
};

/** Título que só existe se o contato tiver nome. */
const PLANO_TITULO_VAZIO = {
  id: "plano-titulo-vazio",
  nome: "Título que depende do contato",
  passos: [
    { ordem: 1, titulo: "Confirmar o contato", vence_em_dias: 0, atribuir_a: "dono_do_lead" },
    { ordem: 2, titulo: "{{contact.name}}", vence_em_dias: 1, atribuir_a: "dono_do_lead" },
  ],
};

const SETTINGS = { task_plans: [PLANO_3_PASSOS, PLANO_COM_DONO_DEPOIS, PLANO_TITULO_VAZIO] };

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name, settings)
     values ($1, $2, 'Org A do piloto', 'Org A', $3),
            ($4, $5, 'Org B do piloto', 'Org B', $3)`,
    [ORG_A, "piloto-3715-a", SETTINGS, ORG_B, "piloto-3715-b"],
  );

  await pool.query(
    `insert into auth.users (id, email) values
       ($1, 'piloto-3715-dono@invariant.test'),
       ($2, 'piloto-3715-viewer@invariant.test'),
       ($3, 'piloto-3715-revogado@invariant.test'),
       ($4, 'piloto-3715-b@invariant.test'),
       ($5, 'piloto-3715-outro@invariant.test')`,
    [DONO_A, VIEWER_A, REVOGADO_A, USER_B, OUTRO],
  );

  await pool.query(
    `insert into user_organizations (user_id, organization_id, role, accepted_at, revoked_at) values
       ($1, $2, 'manager', now(), null),
       ($3, $2, 'viewer',  now(), null),
       ($4, $2, 'agent',   now(), now()),
       ($5, $6, 'manager', now(), null)`,
    [DONO_A, ORG_A, VIEWER_A, REVOGADO_A, USER_B, ORG_B],
  );

  await pool.query(
    `insert into crm_pipelines (id, organization_id, name, slug) values
       ($1, $2, 'Funil A', 'piloto-3715-a'),
       ($3, $4, 'Funil B', 'piloto-3715-b')`,
    [FUNIL_A, ORG_A, FUNIL_B, ORG_B],
  );

  await pool.query(
    `insert into crm_stages (id, organization_id, pipeline_id, name, slug, position) values
       ($1, $2, $3, 'Entrada', 'entrada-a', 1000),
       ($4, $5, $6, 'Entrada', 'entrada-b', 1000)`,
    [ETAPA_A, ORG_A, FUNIL_A, ETAPA_B, ORG_B, FUNIL_B],
  );

  await pool.query(
    `insert into contacts (id, organization_id, name, display_name) values
       ($1, $2, 'Ana Souza', null),
       ($3, $2, null, null),
       ($4, $5, 'Cliente B', null)`,
    [CONTATO_A, ORG_A, CONTATO_SEM_NOME_A, CONTATO_B, ORG_B],
  );

  await pool.query(
    `insert into crm_leads (id, organization_id, pipeline_id, stage_id, contact_id, title, owner_user_id) values
       ($1,  $2, $3, $4, $5,  'Renovação do contrato', $6),
       ($7,  $2, $3, $4, $5,  'Negócio sem dono',       null),
       ($8,  $2, $3, $4, $9,  'Negócio sem nome',       $6),
       ($10, $11, $12, $13, $14, 'Negócio da B',        $15)`,
    [
      LEAD_A,
      ORG_A,
      FUNIL_A,
      ETAPA_A,
      CONTATO_A,
      DONO_A,
      LEAD_SEM_DONO_A,
      LEAD_SEM_NOME_A,
      CONTATO_SEM_NOME_A,
      LEAD_B,
      ORG_B,
      FUNIL_B,
      ETAPA_B,
      CONTATO_B,
      USER_B,
    ],
  );

  await pool.query(
    `insert into demandas (id, organization_id, contact_id, lead_id, origem, estado, desfecho, fechada_em) values
       ($1, $2, $3, $4, 'manual', 'aberta',    null,       null),
       ($5, $2, $3, $4, 'manual', 'encerrada', 'resolvida', now()),
       ($6, $7, $8, $9, 'manual', 'aberta',    null,       null)`,
    [
      DEMANDA_ABERTA_A,
      ORG_A,
      CONTATO_A,
      LEAD_A,
      DEMANDA_FECHADA_A,
      DEMANDA_B,
      ORG_B,
      CONTATO_B,
      LEAD_B,
    ],
  );
});

async function tarefasDa(orgId: string) {
  const { rows } = await pool.query(
    `select id, organization_id, title, status, priority, lead_id, contact_id, assigned_to, due_date
       from crm_tasks
      where organization_id = $1
      order by created_at asc`,
    [orgId],
  );
  return rows as Array<Record<string, unknown>>;
}

async function atividadesDo(leadId: string, tipo?: string) {
  const { rows } = await pool.query(
    `select type, actor_kind, source_module, source_id, reason, payload, organization_id
       from crm_lead_activities
      where lead_id = $1 and ($2::text is null or type = $2)`,
    [leadId, tipo ?? null],
  );
  return rows as Array<Record<string, unknown>>;
}

describe("criarTarefaInterna grava a tarefa e o laço de retorno", () => {
  it("⭐ INSERT em crm_tasks + linha em crm_lead_activities (ator system, mesmo negócio)", async () => {
    const resultado = await criarTarefaInterna(db, {
      organizationId: ORG_A,
      titulo: "Ligar para {{contact.name}} sobre {{lead.title}}",
      venceEmDias: 1,
      atribuirA: "dono_do_lead",
      prioridade: "high",
      leadId: LEAD_A,
      origem: "automation:regra-1",
      agora: AGORA,
    });

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;

    const tarefa = (await tarefasDa(ORG_A)).find((t) => t.id === resultado.tarefa_id);
    expect(tarefa).toMatchObject({
      title: "Ligar para Ana Souza sobre Renovação do contrato",
      status: "pending",
      priority: "high",
      lead_id: LEAD_A,
      contact_id: CONTATO_A,
      assigned_to: DONO_A,
    });
    expect(new Date(String(tarefa?.due_date)).toISOString()).toBe(
      new Date(AGORA.getTime() + 86_400_000).toISOString(),
    );

    const atividades = await atividadesDo(LEAD_A, "task_created");
    expect(atividades).toHaveLength(1);
    expect(atividades[0]).toMatchObject({
      actor_kind: "system",
      source_module: "tarefas",
      source_id: resultado.tarefa_id,
      reason: "Ligar para Ana Souza sobre Renovação do contrato",
      organization_id: ORG_A,
    });
    // O payload é jsonb de verdade — se o driver tivesse mandado texto, isto
    // viria string e o `due_date` sumiria.
    expect(atividades[0]?.payload).toMatchObject({ priority: "high" });
  });

  it("tarefa solta (sem negócio) grava só em crm_tasks — lead_id é not null na timeline", async () => {
    const antes = (await atividadesDo(LEAD_A, "task_created")).length;

    const resultado = await criarTarefaInterna(db, {
      organizationId: ORG_A,
      titulo: "Revisar os textos do agente",
      venceEmDias: 2,
      atribuirA: { usuario_id: DONO_A },
      prioridade: "low",
      contactId: CONTATO_A,
      origem: "followup:internal_task",
      agora: AGORA,
    });

    expect(resultado.ok).toBe(true);
    if (resultado.ok) {
      const tarefa = (await tarefasDa(ORG_A)).find((t) => t.id === resultado.tarefa_id);
      expect(tarefa).toMatchObject({ lead_id: null, contact_id: CONTATO_A, assigned_to: DONO_A });
    }
    expect((await atividadesDo(LEAD_A, "task_created")).length).toBe(antes);
  });

  it("sem negócio e sem contato o banco não é tocado: recusa `sem_alvo`", async () => {
    const resultado = await criarTarefaInterna(db, {
      organizationId: ORG_A,
      titulo: "Sem alvo",
      venceEmDias: 0,
      atribuirA: { usuario_id: DONO_A },
      prioridade: "low",
      origem: "automation:regra-x",
      agora: AGORA,
    });

    expect(resultado).toEqual({ ok: false, codigo: "sem_alvo" });
  });
});

describe("aplicarPlanoDeTarefas — ordem, prazo e idempotência sobre SQL", () => {
  it("⭐ cria as 3 tarefas na ordem declarada, com prazo relativo e a marca da aplicação", async () => {
    const resultado = await aplicarPlanoDeTarefas(db, {
      organizationId: ORG_A,
      leadId: LEAD_A,
      planoId: PLANO_3_PASSOS.id,
      origem: "automation:regra-1",
      agora: AGORA,
    });

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(resultado.ja_aplicado).toBe(false);
    expect(resultado.tarefa_ids).toHaveLength(3);

    const tarefas = (await tarefasDa(ORG_A)).filter((t) => t.id !== undefined);
    const doPlano = tarefas.filter((t) =>
      (resultado.tarefa_ids as string[]).includes(String(t.id)),
    );
    expect(doPlano.map((t) => t.title)).toEqual([
      "Agradecer a proposta de Renovação do contrato",
      "Ligar para conferir o recebimento",
      "Enviar o caso de sucesso",
    ]);
    expect(doPlano.map((t) => t.priority)).toEqual(["high", "medium", "low"]);
    expect(doPlano.map((t) => t.assigned_to)).toEqual([DONO_A, DONO_A, OUTRO]);
    expect(
      doPlano.map((t) => new Date(String(t.due_date)).toISOString()),
      "o prazo é relativo a `agora`: 0, 2 e 5 dias",
    ).toEqual([
      AGORA.toISOString(),
      new Date(AGORA.getTime() + 2 * 86_400_000).toISOString(),
      new Date(AGORA.getTime() + 5 * 86_400_000).toISOString(),
    ]);

    const marcas = await atividadesDo(LEAD_A, "task_plan_applied");
    expect(marcas).toHaveLength(1);
    expect(marcas[0]?.payload).toMatchObject({
      plano_id: PLANO_3_PASSOS.id,
      passos: 3,
    });
  });

  it("⭐ reaplicar o mesmo plano no mesmo negócio não duplica", async () => {
    const antes = (await tarefasDa(ORG_A)).length;

    const resultado = await aplicarPlanoDeTarefas(db, {
      organizationId: ORG_A,
      leadId: LEAD_A,
      planoId: PLANO_3_PASSOS.id,
      origem: "automation:regra-1",
      agora: AGORA,
    });

    expect(resultado).toEqual({ ok: true, ja_aplicado: true, tarefa_ids: [] });
    expect((await tarefasDa(ORG_A)).length).toBe(antes);
    expect(await atividadesDo(LEAD_A, "task_plan_applied")).toHaveLength(1);
  });

  it("plano desconhecido é recusa de configuração e não escreve nada", async () => {
    const antes = (await tarefasDa(ORG_A)).length;

    const resultado = await aplicarPlanoDeTarefas(db, {
      organizationId: ORG_A,
      leadId: LEAD_A,
      planoId: "nao-existe",
      origem: "automation:regra-1",
      agora: AGORA,
    });

    expect(resultado).toEqual({ ok: false, codigo: "plano_nao_encontrado" });
    expect((await tarefasDa(ORG_A)).length).toBe(antes);
  });

  it("⭐ `sem_dono` no meio do plano recusa ANTES do primeiro INSERT — 2 aplicações, 0 tarefa", async () => {
    const antes = (await tarefasDa(ORG_A)).length;
    const pedido = {
      organizationId: ORG_A,
      leadId: LEAD_SEM_DONO_A,
      planoId: PLANO_COM_DONO_DEPOIS.id,
      origem: "automation:regra-1",
      agora: AGORA,
    };

    expect(await aplicarPlanoDeTarefas(db, pedido)).toEqual({ ok: false, codigo: "sem_dono" });
    expect(await aplicarPlanoDeTarefas(db, pedido)).toEqual({ ok: false, codigo: "sem_dono" });

    // Nem o passo 1 (que passaria) nem a marca: é a sobra do laço que a revisão
    // do #2213 mediu, e ela não pode nascer mais.
    expect((await tarefasDa(ORG_A)).length).toBe(antes);
    expect(await atividadesDo(LEAD_SEM_DONO_A, "task_plan_applied")).toHaveLength(0);
  });

  it("título que vira vazio no meio também é recusado antes do primeiro INSERT", async () => {
    const antes = (await tarefasDa(ORG_A)).length;
    const pedido = {
      organizationId: ORG_A,
      leadId: LEAD_SEM_NOME_A,
      planoId: PLANO_TITULO_VAZIO.id,
      origem: "automation:regra-1",
      agora: AGORA,
    };

    expect(await aplicarPlanoDeTarefas(db, pedido)).toEqual({ ok: false, codigo: "titulo_vazio" });
    expect((await tarefasDa(ORG_A)).length).toBe(antes);
  });
});

describe("conferirDemanda — a régua do vínculo com o atendimento", () => {
  it("demanda aberta da organização é aceita; encerrada é recusada com o código próprio", async () => {
    expect(await conferirDemanda(db, ORG_A, DEMANDA_ABERTA_A)).toBe("aceita");
    expect(await conferirDemanda(db, ORG_A, DEMANDA_FECHADA_A)).toBe("encerrada");
  });

  it("⭐ demanda de OUTRA organização é `fora_da_organizacao` — o filtro é o SQL, não a RLS", async () => {
    expect(await conferirDemanda(db, ORG_A, DEMANDA_B)).toBe("fora_da_organizacao");
    expect(await conferirDemanda(db, ORG_B, DEMANDA_ABERTA_A)).toBe("fora_da_organizacao");
  });

  it("erro do banco vira `falha_na_consulta`, nunca aceite (id fora do formato uuid)", async () => {
    expect(await conferirDemanda(db, ORG_A, "nao-e-um-uuid")).toBe("falha_na_consulta");
  });
});

describe("conferirResponsavel — a régua da equipe, sobre SQL", () => {
  it("membro ativo é aceito", async () => {
    expect(await conferirResponsavel(db, ORG_A, DONO_A)).toBe("aceito");
  });

  it("viewer, revogado e gente de outra organização são recusados", async () => {
    expect(await conferirResponsavel(db, ORG_A, VIEWER_A)).toBe("fora_da_equipe");
    expect(await conferirResponsavel(db, ORG_A, REVOGADO_A)).toBe("fora_da_equipe");
    expect(await conferirResponsavel(db, ORG_A, USER_B)).toBe("fora_da_equipe");
    expect(await conferirResponsavel(db, ORG_B, DONO_A)).toBe("fora_da_equipe");
  });
});

/**
 * ═══ O CRITÉRIO DE SAÍDA DA FASE (#3715 §3.3) ═══
 *
 * Com o PostgREST, quem segurava o tenant era a RLS + o `.eq("organization_id")`.
 * Com SQL direto no pool (que NÃO passa por RLS), o filtro é só o que está
 * escrito — e é por isso que a prova abaixo existe: a query errada tem de
 * devolver ZERO linhas, e a escrita com id alheio tem de ser recusada.
 */
describe("isolamento entre organizações com a query nova", () => {
  it("⭐ a organização A não LÊ a tarefa da B (nem a do próprio negócio da B)", async () => {
    const criadaNaB = await criarTarefaInterna(db, {
      organizationId: ORG_B,
      titulo: "Tarefa da B",
      venceEmDias: 0,
      atribuirA: "dono_do_lead",
      prioridade: "medium",
      leadId: LEAD_B,
      origem: "automation:regra-1",
      agora: AGORA,
    });
    expect(criadaNaB.ok).toBe(true);
    if (!criadaNaB.ok) return;

    const vistasPelaA = await db.query<{ id: string }>(
      `select id from crm_tasks where organization_id = $1 and id = $2`,
      [ORG_A, criadaNaB.tarefa_id],
    );
    expect(vistasPelaA).toEqual([]);

    const vistasPelaB = await db.query<{ id: string }>(
      `select id from crm_tasks where organization_id = $1 and id = $2`,
      [ORG_B, criadaNaB.tarefa_id],
    );
    expect(vistasPelaB).toHaveLength(1);
  });

  it("⭐ a organização A não ESCREVE tarefa no negócio da B — `sem_alvo`, 0 linha nova", async () => {
    const antesB = (await tarefasDa(ORG_B)).length;
    const antesA = (await tarefasDa(ORG_A)).length;

    const resultado = await criarTarefaInterna(db, {
      organizationId: ORG_A,
      titulo: "Tarefa que não pode existir",
      venceEmDias: 0,
      atribuirA: { usuario_id: DONO_A },
      prioridade: "high",
      leadId: LEAD_B,
      origem: "automation:regra-1",
      agora: AGORA,
    });

    expect(resultado).toEqual({ ok: false, codigo: "sem_alvo" });
    expect((await tarefasDa(ORG_B)).length).toBe(antesB);
    expect((await tarefasDa(ORG_A)).length).toBe(antesA);
  });

  it("⭐ plano com o MESMO id configurado nas duas não aplica no negócio da outra", async () => {
    const antesB = (await tarefasDa(ORG_B)).length;

    const resultado = await aplicarPlanoDeTarefas(db, {
      organizationId: ORG_A,
      leadId: LEAD_B,
      planoId: PLANO_3_PASSOS.id,
      origem: "automation:regra-1",
      agora: AGORA,
    });

    expect(resultado).toEqual({ ok: false, codigo: "sem_alvo" });
    expect((await tarefasDa(ORG_B)).length).toBe(antesB);
  });

  it("registrar atividade com negócio de outra organização não é alcançável pela régua da tarefa", async () => {
    // `registraAtividadeDaTarefa` não confere tenant sozinha — ela grava o que
    // recebe, como antes. O que a torna segura é o chamador: as duas portas
    // (tela e automática) só chegam aqui com uma tarefa que JÁ foi lida com o
    // filtro de organização. Este caso prende o contrato: o negócio da B, com
    // a organização da A, não aparece na leitura da A.
    const leadDaB = await db.queryOne<{ id: string }>(
      `select id from crm_leads where id = $1 and organization_id = $2`,
      [LEAD_B, ORG_A],
    );
    expect(leadDaB).toBeNull();

    const ok = await registraAtividadeDaTarefa(db, {
      organizationId: ORG_A,
      tarefa: {
        id: "e3715000-0000-4000-8000-0000000009ff",
        title: "Linha da A sobre negócio lido da A",
        due_date: AGORA.toISOString(),
        priority: "medium",
        lead_id: LEAD_A,
        contact_id: CONTATO_A,
      },
      tipo: "task_created",
      actor: { type: "user", id: DONO_A },
    });
    expect(ok.ok).toBe(true);
  });
});
