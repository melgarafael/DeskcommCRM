import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import { createSupabaseAdminClient, runFollowupTick, type FollowupJobRequest, type TickDeps } from "@/lib/followup/engine";
import { flowGraphSchema, type FlowGraph } from "@/lib/followup/graph-schema";
import { createPgAdminClient } from "@/lib/followup/turn-bridge";

import { pgComoSupabase } from "../pg-como-supabase";
import { isolarFixtureDeFollowup } from "./followup-isolamento";
import { criarOrigemDeFollowup } from "./followup-service-origin";
import { relogioAncoradoNoBanco } from "./followup-relogio";

/**
 * A CONDIÇÃO «ETIQUETA DO CONTATO» ENXERGA A ETIQUETA QUE A CAMPANHA GRAVOU NO CONTATO (#4586).
 *
 * ## O defeito, medido na `main`
 *
 * O produto grava marcador em duas caixas que não são a mesma: `crm_leads.tags`
 * (do negócio, «Editar negócio») e `contacts.tags` (da pessoa, Inbox e ficha).
 * A campanha de prospecção usa a SEGUNDA — `marcarEtiquetasDaCampanha` com
 * `config.contact_tags`, vinda do «Público ou segmento».
 *
 * O #4606 já copia essas etiquetas para o card NO NASCIMENTO, e declara o
 * limite: «vale para os cards criados a partir da atualização; os que já
 * existem não mudam». Para card antigo — e para etiqueta posta no contato por
 * fora da campanha, que nunca chega ao card — a condição do follow-up
 * respondia «não tem» e o fluxo caía sempre no ramo padrão, com a tela dizendo
 * «O contato tem a etiqueta…». É essa metade que este arquivo prova: a etiqueta
 * que já está gravada em `contacts.tags` passa a decidir o ramo.
 *
 * ## O que este arquivo congela
 *
 * 1. campanha de nicho X com card ANTIGO (sem etiqueta no card) → ramo do X,
 *    pelo caminho de PRODUÇÃO do tick (`createPgAdminClient`);
 * 2. etiqueta manual no CARD continua valendo — a união não troca de caixa;
 * 3. card antigo, sem etiqueta em nenhuma das duas caixas, não quebra a
 *    condição: ela responde «não» e o fluxo segue (sem erro, sem inscrição morta);
 * 4. o adapter `pg` puro (o do worker 24/7, `createPgAdminClient`) responde o
 *    mesmo que o adapter REST — a régua é uma só.
 *
 * Roda contra o Postgres efêmero de `pnpm test:db` (sem PostgREST): o caminho
 * Supabase é exercitado por `pgComoSupabase`, que traduz `.from(...).select(...)`
 * em SQL de verdade.
 */

if (!process.env.TEST_DB_CONTAINER) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 4,
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await isolarFixtureDeFollowup(pool);
});

const P = { x: 0, y: 0 };
const NICHO = "dentista";

/** O desenho do relato: uma condição de etiqueta, duas saídas — «tem» e «padrão». */
function grafoDaEtiqueta(etiqueta: string): FlowGraph {
  return {
    nodes: [
      { id: "t1", type: "trigger", label: "Início", position: P, config: {} },
      {
        id: "c1",
        type: "condition",
        label: `É ${etiqueta}?`,
        position: P,
        config: { combinator: "and", checks: [{ field: "tag", op: "eq", value: etiqueta }] },
      },
      { id: "e_nicho", type: "end", label: "Texto do nicho", position: P, config: { outcome: "converted" } },
      { id: "e_padrao", type: "end", label: "Texto padrão", position: P, config: { outcome: "exhausted" } },
    ],
    edges: [
      { id: "t1-c1", source: "t1", target: "c1", priority: 0, condition: { type: "always" } },
      { id: "c1-sim", source: "c1", target: "e_nicho", priority: 0, condition: { type: "cond_result", value: true } },
      { id: "c1-nao", source: "c1", target: "e_padrao", priority: 0, condition: { type: "cond_result", value: false } },
    ],
  };
}

interface Fixture {
  org: string;
  contactId: string;
  leadId: string;
  pipelineId: string;
  stageId: string;
}

/**
 * Um lead como uma instalação que rodou campanha ANTES do #4606 deixa: contato
 * com as etiquetas do nicho e negócio sem etiqueta (`negocioBase` só passou a
 * copiar a lista para o card depois daquela atualização). `etiquetasDoCard`
 * também serve para o caso da etiqueta posta à mão no card.
 */
async function seedLeadDacampanha(params: {
  etiquetasDoContato: string[];
  etiquetasDoCard: string[];
}): Promise<Fixture> {
  const org = randomUUID();
  const marca = `${Date.now()}${Math.floor(Math.random() * 10_000)}`;
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1, $2, $3, $4)`,
    [org, `etiqueta-4586-${org.slice(0, 8)}`, `Etiqueta 4586 ${marca}`, `Etiqueta 4586 ${marca}`],
  );
  const { rows: contato } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, display_name, tags) values ($1, 'Lead da campanha', $2::text[]) returning id`,
    [org, params.etiquetasDoContato],
  );
  const { rows: funil } = await pool.query<{ id: string }>(
    `insert into crm_pipelines (organization_id, name, slug) values ($1, 'Prospecção', $2) returning id`,
    [org, `prospeccao-${marca}`.slice(0, 40)],
  );
  const pipelineId = funil[0]!.id;
  const { rows: etapa } = await pool.query<{ id: string }>(
    `insert into crm_stages (organization_id, pipeline_id, name, slug, position) values ($1, $2, 'Abordado', $3, 1000) returning id`,
    [org, pipelineId, `abordado-${marca}`.slice(0, 40)],
  );
  const stageId = etapa[0]!.id;
  const { rows: negocio } = await pool.query<{ id: string }>(
    `insert into crm_leads (organization_id, pipeline_id, stage_id, contact_id, title, source, tags)
     values ($1, $2, $3, $4, 'Negócio da campanha', 'prospecting', $5::text[]) returning id`,
    [org, pipelineId, stageId, contato[0]!.id, params.etiquetasDoCard],
  );
  return { org, contactId: contato[0]!.id, leadId: negocio[0]!.id, pipelineId, stageId };
}

async function seedFluxoComEtiqueta(org: string, etiqueta: string): Promise<{ pointerId: string; versionId: string }> {
  const graph = flowGraphSchema.parse(grafoDaEtiqueta(etiqueta));
  const { rows: versao } = await pool.query<{ id: string }>(
    `insert into followup_flow_versions (organization_id, graph) values ($1, $2) returning id`,
    [org, JSON.stringify(graph)],
  );
  const versionId = versao[0]!.id;
  const { rows: ponteiro } = await pool.query<{ id: string }>(
    `insert into followup_flow_pointers (organization_id, name, status, active_version_id)
     values ($1, $2, 'active', $3) returning id`,
    [org, `Fluxo por nicho ${Date.now()}-${Math.random()}`, versionId],
  );
  return { pointerId: ponteiro[0]!.id, versionId };
}

async function seedInscricao(params: {
  org: string;
  pointerId: string;
  versionId: string;
  contactId: string;
}): Promise<string> {
  const boundary = await criarOrigemDeFollowup(pool, params.org, params.contactId);
  const { rows } = await pool.query<{ id: string }>(
    `insert into followup_enrollments
       (organization_id, pointer_id, version_id, contact_id, current_node_id, status, next_eval_at,
        steps_taken, attempts, max_attempts, conversation_id, service_boundary)
     values ($1, $2, $3, $4, 't1', 'active', now() - interval '1 second', 0, 0, 5, $5, $6::jsonb)
     returning id`,
    [params.org, params.pointerId, params.versionId, params.contactId, boundary.conversation_id, JSON.stringify(boundary)],
  );
  return rows[0]!.id;
}

/** Dois ticks: trigger → condição, condição → ramo escolhido. */
async function rodarAteORamo(): Promise<void> {
  const jobs: FollowupJobRequest[] = [];
  const deps: TickDeps = {
    db: createPgAdminClient(pool),
    clock: relogioAncoradoNoBanco(),
    enqueueJob: async (job) => {
      jobs.push(job);
    },
  };
  for (let i = 0; i < 2; i += 1) {
    const resumo = await runFollowupTick(deps, { limit: 5 });
    expect(resumo.failed, "o tick falhou — ver last_error da inscrição").toBe(0);
  }
}

async function noDoEnrollment(id: string): Promise<string> {
  const { rows } = await pool.query<{ current_node_id: string }>(
    `select current_node_id from followup_enrollments where id = $1`,
    [id],
  );
  return rows[0]!.current_node_id;
}

describe("#4586 — a campanha etiqueta o CONTATO e a condição do follow-up enxerga", () => {
  it("nicho X no contato + card sem etiqueta → o fluxo cai no ramo do nicho X", async () => {
    const f = await seedLeadDacampanha({ etiquetasDoContato: [NICHO], etiquetasDoCard: [] });
    const { pointerId, versionId } = await seedFluxoComEtiqueta(f.org, NICHO);
    const enrollmentId = await seedInscricao({ org: f.org, pointerId, versionId, contactId: f.contactId });

    await rodarAteORamo();

    expect(await noDoEnrollment(enrollmentId)).toBe("e_nicho");
  });

  it("etiqueta manual no CARD continua valendo (a união não troca de caixa)", async () => {
    const f = await seedLeadDacampanha({ etiquetasDoContato: [], etiquetasDoCard: ["vip"] });
    const { pointerId, versionId } = await seedFluxoComEtiqueta(f.org, "vip");
    const enrollmentId = await seedInscricao({ org: f.org, pointerId, versionId, contactId: f.contactId });

    await rodarAteORamo();

    expect(await noDoEnrollment(enrollmentId)).toBe("e_nicho");
  });

  it("card antigo sem etiqueta em nenhuma das caixas → ramo padrão, sem quebrar", async () => {
    const f = await seedLeadDacampanha({ etiquetasDoContato: [], etiquetasDoCard: [] });
    const { pointerId, versionId } = await seedFluxoComEtiqueta(f.org, NICHO);
    const enrollmentId = await seedInscricao({ org: f.org, pointerId, versionId, contactId: f.contactId });

    await rodarAteORamo();

    expect(await noDoEnrollment(enrollmentId)).toBe("e_padrao");
    const { rows } = await pool.query<{ status: string; last_error: string | null }>(
      `select status, last_error from followup_enrollments where id = $1`,
      [enrollmentId],
    );
    expect(rows[0]!.status).toBe("active");
    expect(rows[0]!.last_error).toBeNull();
  });

  it("os dois adapters de produção leem as duas caixas — a régua é uma só", async () => {
    const f = await seedLeadDacampanha({ etiquetasDoContato: [NICHO], etiquetasDoCard: ["vip"] });

    // Caminho do cron/REST (engine.ts → createSupabaseAdminClient).
    const pelaREST = await createSupabaseAdminClient(pgComoSupabase(pool)).loadLeadFacts(
      f.org,
      f.contactId,
      f.pipelineId,
    );
    // Caminho do worker 24/7 (turn-bridge.ts → createPgAdminClient).
    const peloPg = await createPgAdminClient(pool).loadLeadFacts(f.org, f.contactId);

    for (const fatos of [pelaREST, peloPg]) {
      expect(fatos.tags).toContain(NICHO);
      expect(fatos.tags).toContain("vip");
      expect(fatos.tags.filter((t) => t === NICHO)).toHaveLength(1);
    }
  });
});
