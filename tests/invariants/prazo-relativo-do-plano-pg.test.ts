import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";

import { criarPorta } from "@/lib/db";
import { aplicarPlanoDeTarefas } from "@/lib/tarefas/plano";

/**
 * #4717 ITEM 4 — o prazo do passo do plano relativo a um campo de DATA do card.
 *
 * O que este arquivo prova, e por que ele NÃO podia ser unitário:
 *
 *   1. **o prazo nasce da data do campo**, para trás e para frente, no fuso da
 *      ORGANIZAÇÃO (não em UTC, não no fuso do processo);
 *   2. **campo vazio não inventa prazo**: a tarefa nasce sem `due_date`, com o
 *      motivo e o nome do campo gravados na própria linha, e o motivo aparece no
 *      texto que a pessoa lê na linha do tempo do negócio;
 *   3. **mudar a data do card recalcula as tarefas ABERTAS do plano** e não toca
 *      nas concluídas — o gatilho `crm_leads_recalcula_prazos_do_plano` é quem
 *      faz isso, e um banco falso não teria gatilho nenhum para provar;
 *   4. **o plano antigo continua idêntico**: `vence_em_dias` ainda conta da
 *      aplicação, com a mesma conta de antes (controle da retrocompatibilidade).
 *
 * `audit` e o push são mockados pelo mesmo motivo do `tarefas-piloto-pg`: são
 * efeitos EXTERNOS ao caminho sob teste, e batê-los de verdade faria o teste
 * medir a rede em vez do SQL.
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
const ORG = "e4717000-0000-4000-8000-00000000000a";
const DONO = "e4717000-0000-4000-8000-000000000101";
const FUNIL = "e4717000-0000-4000-8000-000000000301";
const ETAPA = "e4717000-0000-4000-8000-000000000302";
const CONTATO = "e4717000-0000-4000-8000-000000000401";

const LEAD_ANTES = "e4717000-0000-4000-8000-000000000501";
const LEAD_DEPOIS = "e4717000-0000-4000-8000-000000000502";
const LEAD_VAZIO = "e4717000-0000-4000-8000-000000000503";
const LEAD_RECALC = "e4717000-0000-4000-8000-000000000504";
const LEAD_CONTROLE = "e4717000-0000-4000-8000-000000000505";

/** Fuso DIFERENTE de UTC: é o que faz a sabotagem "calcular em UTC" morder. */
const FUSO = "America/Sao_Paulo";
/** 09:00 em São Paulo (UTC-3) = 12:00Z. */
const HORA_DO_PRAZO_EM_UTC = "T12:00:00.000Z";

const AGORA = new Date("2026-11-16T12:00:00.000Z");

const PLANO_ANTES = {
  id: "plano-7-antes-da-viagem",
  nome: "Antes da viagem",
  passos: [
    {
      ordem: 1,
      titulo: "Confirmar o embarque",
      prazo: { modo: "campo_de_data", campo: "data_da_viagem", dias: -7 },
      prioridade: "high",
      atribuir_a: "dono_do_lead",
    },
  ],
};

const PLANO_DEPOIS = {
  id: "plano-3-depois-do-evento",
  nome: "Depois do evento",
  passos: [
    {
      ordem: 1,
      titulo: "Pedir o depoimento",
      prazo: { modo: "campo_de_data", campo: "data_da_viagem", dias: 3 },
      prioridade: "medium",
      atribuir_a: "dono_do_lead",
    },
  ],
};

const PLANO_CAMPO_VAZIO = {
  id: "plano-campo-vazio",
  nome: "Cobrança pela data",
  passos: [
    {
      ordem: 1,
      titulo: "Lembrar o pagamento",
      prazo: { modo: "campo_de_data", campo: "data_do_pagamento", dias: -2 },
      prioridade: "medium",
      atribuir_a: "dono_do_lead",
    },
  ],
};

const PLANO_RECALC = {
  id: "plano-recalculo",
  nome: "Checklist da viagem",
  passos: [
    {
      ordem: 1,
      titulo: "Reservar o transfer",
      prazo: { modo: "campo_de_data", campo: "data_da_viagem", dias: -10 },
      prioridade: "medium",
      atribuir_a: "dono_do_lead",
    },
    {
      ordem: 2,
      titulo: "Conferir o passaporte",
      prazo: { modo: "campo_de_data", campo: "data_da_viagem", dias: -3 },
      prioridade: "medium",
      atribuir_a: "dono_do_lead",
    },
  ],
};

/** O plano de ANTES do #4717: só `vence_em_dias`, sem `prazo` nenhum. */
const PLANO_LEGADO = {
  id: "plano-legado",
  nome: "Proposta enviada",
  passos: [
    { ordem: 1, titulo: "Agradecer a proposta", vence_em_dias: 0, atribuir_a: "dono_do_lead" },
    { ordem: 2, titulo: "Ligar em dois dias", vence_em_dias: 2, atribuir_a: "dono_do_lead" },
    { ordem: 3, titulo: "Cobrar em cinco", vence_em_dias: 5, atribuir_a: "dono_do_lead" },
  ],
};

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name, settings, timezone)
     values ($1, 'prazo-relativo-4717', 'Org do prazo relativo', 'Prazo relativo', $2, $3)`,
    [
      ORG,
      {
        task_plans: [PLANO_ANTES, PLANO_DEPOIS, PLANO_CAMPO_VAZIO, PLANO_RECALC, PLANO_LEGADO],
      },
      FUSO,
    ],
  );

  await pool.query(`insert into auth.users (id, email) values ($1, 'prazo-4717@invariant.test')`, [
    DONO,
  ]);

  await pool.query(
    `insert into user_organizations (user_id, organization_id, role, accepted_at, revoked_at)
     values ($1, $2, 'manager', now(), null)`,
    [DONO, ORG],
  );

  await pool.query(
    `insert into crm_pipelines (id, organization_id, name, slug)
     values ($1, $2, 'Funil da viagem', 'prazo-4717')`,
    [FUNIL, ORG],
  );

  await pool.query(
    `insert into crm_stages (id, organization_id, pipeline_id, name, slug, position)
     values ($1, $2, $3, 'Entrada', 'entrada-4717', 1000)`,
    [ETAPA, ORG, FUNIL],
  );

  await pool.query(
    `insert into contacts (id, organization_id, name, display_name)
     values ($1, $2, 'Viajante Sintético', null)`,
    [CONTATO, ORG],
  );

  await pool.query(
    `insert into crm_leads (id, organization_id, pipeline_id, stage_id, contact_id, title, owner_user_id, custom_fields)
     values ($1, $2, $3, $4, $5, 'Viagem de março',      $6, '{"data_da_viagem":"2027-03-15"}'::jsonb),
            ($7, $2, $3, $4, $5, 'Evento de abril',      $6, '{"data_da_viagem":"2027-04-20"}'::jsonb),
            ($8, $2, $3, $4, $5, 'Pagamento sem data',   $6, '{}'::jsonb),
            ($9, $2, $3, $4, $5, 'Viagem remarcada',     $6, '{"data_da_viagem":"2027-05-10"}'::jsonb),
            ($10, $2, $3, $4, $5, 'Proposta antiga',     $6, '{}'::jsonb)`,
    [LEAD_ANTES, ORG, FUNIL, ETAPA, CONTATO, DONO, LEAD_DEPOIS, LEAD_VAZIO, LEAD_RECALC, LEAD_CONTROLE],
  );
});

interface LinhaDaTarefa {
  id: string;
  title: string;
  status: string;
  due_date: Date | null;
  plan_id: string | null;
  plan_step: number | null;
  prazo_campo: string | null;
  prazo_dias: number | null;
  prazo_motivo: string | null;
}

async function tarefasDoNegocio(leadId: string): Promise<LinhaDaTarefa[]> {
  return db.query<LinhaDaTarefa>(
    `select id, title, status, due_date, plan_id, plan_step, prazo_campo, prazo_dias, prazo_motivo
       from crm_tasks
      where organization_id = $1
        and lead_id = $2
      order by plan_step nulls last, title`,
    [ORG, leadId],
  );
}

function iso(valor: Date | null): string | null {
  return valor ? valor.toISOString() : null;
}

describe("#4717 item 4 — prazo do passo relativo a um campo de data do card", () => {
  it("passo com 7 dias antes da data do campo nasce com o prazo certo, no fuso da organização", async () => {
    const r = await aplicarPlanoDeTarefas(db, {
      organizationId: ORG,
      leadId: LEAD_ANTES,
      planoId: PLANO_ANTES.id,
      origem: "teste:prazo-relativo",
      agora: AGORA,
    });
    expect(r.ok).toBe(true);

    const [tarefa] = await tarefasDoNegocio(LEAD_ANTES);
    expect(tarefa?.title).toBe("Confirmar o embarque");
    // 2027-03-15 menos 7 dias = 2027-03-08, às 09:00 de São Paulo = 12:00Z.
    // Se a conta fosse em UTC, este instante seria 09:00Z e o dia do prazo
    // escorregaria para quem trabalha no fuso do tenant.
    expect(iso(tarefa?.due_date ?? null)).toBe(`2027-03-08${HORA_DO_PRAZO_EM_UTC}`);
    expect(tarefa?.prazo_campo).toBe("data_da_viagem");
    expect(tarefa?.prazo_dias).toBe(-7);
    expect(tarefa?.prazo_motivo).toBeNull();
    expect(tarefa?.plan_id).toBe(PLANO_ANTES.id);
    expect(tarefa?.plan_step).toBe(1);
  });

  it("passo com 3 dias depois da data do campo nasce com o prazo certo", async () => {
    const r = await aplicarPlanoDeTarefas(db, {
      organizationId: ORG,
      leadId: LEAD_DEPOIS,
      planoId: PLANO_DEPOIS.id,
      origem: "teste:prazo-relativo",
      agora: AGORA,
    });
    expect(r.ok).toBe(true);

    const [tarefa] = await tarefasDoNegocio(LEAD_DEPOIS);
    expect(tarefa?.title).toBe("Pedir o depoimento");
    // 2027-04-20 mais 3 dias = 2027-04-23, às 09:00 de São Paulo = 12:00Z.
    expect(iso(tarefa?.due_date ?? null)).toBe(`2027-04-23${HORA_DO_PRAZO_EM_UTC}`);
    expect(tarefa?.prazo_dias).toBe(3);
    expect(tarefa?.prazo_motivo).toBeNull();
  });

  it("campo de data vazio faz o passo nascer sem prazo, com o motivo registrado e o campo nomeado", async () => {
    const r = await aplicarPlanoDeTarefas(db, {
      organizationId: ORG,
      leadId: LEAD_VAZIO,
      planoId: PLANO_CAMPO_VAZIO.id,
      origem: "teste:prazo-relativo",
      agora: AGORA,
    });
    expect(r.ok).toBe(true);

    const [tarefa] = await tarefasDoNegocio(LEAD_VAZIO);
    // Sem prazo inventado: `due_date` nulo, que é o estado que a lista de
    // atrasadas já trata como "sem prazo".
    expect(tarefa?.due_date).toBeNull();
    expect(tarefa?.prazo_motivo).toBe("campo_de_data_vazio");
    // E qual campo falta: é este par que a tela usa para dizer o nome.
    expect(tarefa?.prazo_campo).toBe("data_do_pagamento");

    // O motivo também vai para o texto da linha do tempo do negócio — é a tela
    // onde quem abriu o card descobre o que preencher.
    const [marca] = await db.query<{ reason: string | null; payload: { sem_prazo?: unknown } | null }>(
      `select reason, payload
         from crm_lead_activities
        where organization_id = $1
          and lead_id = $2
          and type = 'task_plan_applied'
        limit 1`,
      [ORG, LEAD_VAZIO],
    );
    expect(marca?.reason).toContain("data_do_pagamento");
    expect(marca?.reason?.toLowerCase()).toContain("vazio");
    expect(marca?.payload?.sem_prazo).toEqual([
      { ordem: 1, campo: "data_do_pagamento", motivo: "campo_de_data_vazio" },
    ]);
  });

  it("mudar a data do card recalcula as tarefas abertas e não mexe nas concluídas", async () => {
    const r = await aplicarPlanoDeTarefas(db, {
      organizationId: ORG,
      leadId: LEAD_RECALC,
      planoId: PLANO_RECALC.id,
      origem: "teste:prazo-relativo",
      agora: AGORA,
    });
    expect(r.ok).toBe(true);

    const antes = await tarefasDoNegocio(LEAD_RECALC);
    expect(antes).toHaveLength(2);
    // 2027-05-10 - 10 = 2027-04-30; 2027-05-10 - 3 = 2027-05-07 (09:00 de SP).
    expect(antes.map((t) => iso(t.due_date))).toEqual([
      `2027-04-30${HORA_DO_PRAZO_EM_UTC}`,
      `2027-05-07${HORA_DO_PRAZO_EM_UTC}`,
    ]);

    // A primeira tarefa foi CONCLUÍDA antes da remarcação: o prazo dela é
    // HISTÓRICO e não pode ser reescrito.
    const concluida = antes.find((t) => t.plan_step === 1)!;
    await pool.query(`update crm_tasks set status = 'done' where id = $1`, [concluida.id]);

    // O card muda de 10/05 para 24/05 — 14 dias depois.
    await pool.query(
      `update crm_leads set custom_fields = '{"data_da_viagem":"2027-05-24"}'::jsonb where id = $1`,
      [LEAD_RECALC],
    );

    const depois = await tarefasDoNegocio(LEAD_RECALC);
    const aberta = depois.find((t) => t.plan_step === 2)!;
    const fechada = depois.find((t) => t.plan_step === 1)!;

    // A ABERTA andou junto com a data do card: 2027-05-24 - 3 = 2027-05-21.
    expect(iso(aberta.due_date)).toBe(`2027-05-21${HORA_DO_PRAZO_EM_UTC}`);
    expect(aberta.prazo_motivo).toBeNull();
    // A CONCLUÍDA ficou exatamente onde estava: nada de reescrever histórico.
    expect(iso(fechada.due_date)).toBe(iso(concluida.due_date));
    expect(fechada.status).toBe("done");
  });

  it("plano antigo (dias a partir de hoje) mantém o resultado de antes, sem campo de data", async () => {
    const r = await aplicarPlanoDeTarefas(db, {
      organizationId: ORG,
      leadId: LEAD_CONTROLE,
      planoId: PLANO_LEGADO.id,
      origem: "teste:prazo-relativo",
      agora: AGORA,
    });
    expect(r.ok).toBe(true);

    const tarefas = await tarefasDoNegocio(LEAD_CONTROLE);
    expect(tarefas.map((t) => t.title)).toEqual([
      "Agradecer a proposta",
      "Ligar em dois dias",
      "Cobrar em cinco",
    ]);
    // A conta de sempre, byte a byte: `agora + N × 24h`.
    expect(tarefas.map((t) => iso(t.due_date))).toEqual([
      "2026-11-16T12:00:00.000Z",
      "2026-11-18T12:00:00.000Z",
      "2026-11-21T12:00:00.000Z",
    ]);
    // Nenhuma linha ganhou origem de campo de data — é isto que garante que o
    // gatilho de recálculo não tem o que tocar num plano antigo.
    expect(tarefas.every((t) => t.prazo_campo === null)).toBe(true);
    expect(tarefas.every((t) => t.prazo_motivo === null)).toBe(true);
    expect(tarefas.every((t) => t.plan_id === PLANO_LEGADO.id)).toBe(true);
  });
});
