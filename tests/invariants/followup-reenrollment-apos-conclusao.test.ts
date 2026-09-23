import { afterAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import type { EventRow } from "@/lib/event-log/dispatcher";
import { triggerConfigSchema } from "@/lib/followup/api-schemas";
import type { FollowupGateDb } from "@/lib/followup/agent-followup-gate";
import { noDeGatilhoDoGrafo } from "@/lib/followup/agent-followup-gate";
import {
  EVENTO_DE_ETAPA,
  aplicaGatilhoDeEtapa,
  type GatilhoEtapaDb,
  type PointerDeEtapa,
} from "@/lib/followup/gatilho-etapa";
import type { FlowGraph } from "@/lib/followup/graph-schema";

/**
 * CONGELA O COMPORTAMENTO ATUAL: não há período de carência entre um follow-up
 * que TERMINOU e o próximo do mesmo contato.
 *
 * ⚠️ ESTE TESTE EXISTE PARA FICAR VERMELHO UM DIA, E ISSO É O PONTO. Hoje ele
 * passa. Quando alguém adicionar um cooldown, ele reprova — e a pessoa é
 * obrigada a mudar ou apagar este arquivo, o que transforma a mudança de
 * comportamento numa DECISÃO escrita em vez de um efeito colateral que ninguém
 * percebe. Congelar o que existe é o único jeito de um comportamento aceito hoje
 * não virar acidente amanhã.
 *
 * ⚠️ ISTO NÃO É UM BUG TOLERADO, e quem achar este arquivo daqui a seis meses
 * precisa ler isto antes de "consertar": é a mesma propriedade que
 * `lib/followup/silence-sweep.ts` já documenta no próprio cabeçalho — "um
 * contato que COMPLETOU ou foi cancelado pode ser re-enrollado na varredura
 * seguinte se continuar silencioso; aceitável no MVP, sem cooldown table". O
 * gatilho de etapa herda a mesma regra, de propósito: duas políticas de
 * re-entrada para o mesmo motor seriam duas verdades sobre quando um contato
 * pode voltar à fila.
 *
 * ⚠️ O QUE O CONSERTO DO EMISSOR MUDOU AQUI FOI A PROBABILIDADE, NÃO A REGRA.
 * Antes de `agent-stage-sync` passar a emitir `lead.stage_changed`, só movimento
 * humano (ou de MCP/automação) armava este gatilho. Agora movimento do
 * assistente também arma — e o assistente move mais que gente. A janela de
 * re-entrada é a mesma; ela apenas passa a ser alcançada com mais frequência.
 * Se um dia isso incomodar em produção, o dado vem de lá, não de um chute aqui.
 *
 * O que NÃO é congelado por este arquivo, e continua garantido pelo índice
 * `idx_followup_enrollments_one_live` (org-wide, parcial nos status VIVOS —
 * `active`, `waiting_reply`, `paused_handoff` e, desde a migration 0145,
 * `paused_manual`): enquanto o enrollment está vivo, nenhum segundo nasce. Não
 * há laço — o risco é de frequência, não de recursão.
 *
 * ═══ QUAL LINHA UM COOLDOWN QUEBRA, E O PONTO CEGO QUE SOBRA ═══
 *
 * A linha é uma só, e está marcada abaixo: `expect(depois.enrolled).toBe(1)`.
 * Ela reprova se o cooldown for escrito onde a decisão mora
 * (`aplicaGatilhoDeEtapa`) ou onde o banco decide (uma constraint/índice que
 * passe a cobrir `completed` — aí o insert devolve 23505 e `enrolled` cai a 0).
 *
 * ⚠️ O PONTO CEGO, declarado porque congelamento que se acha completo é pior
 * que congelamento nenhum: este arquivo exercita `aplicaGatilhoDeEtapa` contra
 * um `GatilhoEtapaDb` de teste, escrito em `pg` puro. Um cooldown enfiado
 * DENTRO do adapter de produção (`createSupabaseGatilhoEtapaDb.insereEnrollment`,
 * por exemplo com um `where not exists (... completed_at > now() - interval)`)
 * passaria verde por aqui e mudaria o comportamento em produção — porque o
 * adapter de produção não é o objeto sob teste.
 *
 * Isso não é um defeito a contornar com mais mock: é uma fronteira, e a
 * conclusão que ela impõe é de projeto. **Cooldown é uma DECISÃO sobre quem
 * entra na fila, e decisão pertence a `aplicaGatilhoDeEtapa`, não ao adapter.**
 * O adapter existe para traduzir chamadas em SQL; quando ele começa a decidir
 * quem entra, a regra fica invisível para todo teste que não sobe Supabase — e
 * é assim que uma política de produto vira detalhe de infraestrutura que
 * ninguém encontra. Quem for implementar carência: implemente na decisão, e
 * este arquivo vai reprovar como deve.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 4,
});

/**
 * QUEM SUJA, LIMPA — os pointers que ESTE arquivo criou, e nada além disso.
 * Mesma doutrina (e mesmo racional) de `followup-gatilho-etapa.test.ts`: um
 * enrollment devido deixado aqui entra no `runFollowupTick` do arquivo seguinte
 * e contamina os agregados dele, e quem reprova não é quem sujou.
 *
 * Complementa, e não substitui, a defesa de entrada de quem consome: o
 * `afterAll` não roda se o processo morrer no meio, e a defesa de entrada não
 * protege contra um arquivo novo cujo autor esqueceu de se defender. As duas
 * falham em cenários diferentes, e é por isso que as duas existem.
 *
 * Pelos ids criados aqui, nunca por critério largo: num banco compartilhado por
 * dezenas de arquivos, `delete` amplo apaga a fixture de outro no meio do run
 * dele — o mesmo problema com o sinal trocado.
 */
const pointersCriados: string[] = [];

afterAll(async () => {
  if (pointersCriados.length > 0) {
    // Dois números pelo mesmo motivo do arquivo irmão: DEVIDO rouba vaga do
    // lote de quem roda depois; VIVO não-devido não rouba, mas ocupa o índice
    // único org-wide e pode barrar o insert de outro arquivo no mesmo contato.
    // Zero nos dois é limpeza decorativa, e aí a obrigação é dizer.
    const { rows } = await pool.query<{ devidos: string; totais: string }>(
      `select
         count(*) filter (
           where status in ('active','waiting_reply')
             and next_eval_at is not null and next_eval_at <= now()
         ) as devidos,
         count(*) filter (
           where status in ('active','waiting_reply','paused_handoff','paused_manual')
         ) as totais
       from followup_enrollments where pointer_id = any($1::uuid[])`,
      [pointersCriados],
    );
    process.stdout.write(
      `[followup-reenrollment] deixados para trás antes da limpeza — ` +
        `devidos: ${rows[0]!.devidos}, vivos no total: ${rows[0]!.totais}\n`,
    );
    await pool.query(`delete from followup_flow_pointers where id = any($1::uuid[])`, [pointersCriados]);

    // A segunda metade: "a sujeira existe" e "a limpeza a remove" são
    // afirmações diferentes, e só a segunda justifica este afterAll. Zero aqui
    // é o que autoriza dizer que este arquivo não vaza.
    const { rows: sobrou } = await pool.query<{ devidos: string; totais: string }>(
      `select
         count(*) filter (
           where status in ('active','waiting_reply')
             and next_eval_at is not null and next_eval_at <= now()
         ) as devidos,
         count(*) filter (
           where status in ('active','waiting_reply','paused_handoff','paused_manual')
         ) as totais
       from followup_enrollments where pointer_id = any($1::uuid[])`,
      [pointersCriados],
    );
    process.stdout.write(
      `[followup-reenrollment] DEPOIS da limpeza — ` +
        `devidos: ${sobrou[0]!.devidos}, vivos no total: ${sobrou[0]!.totais}\n`,
    );
  }
  await pool.end();
});

beforeEach(async () => {
  await pool.query(`delete from followup_flow_pointers where name like 'Reenroll Etapa %'`);
});

function gatilhoDb(): GatilhoEtapaDb {
  return {
    async carregaPointersDeEtapa(orgId) {
      const { rows } = await pool.query<{
        id: string;
        organization_id: string;
        active_version_id: string | null;
        trigger_config: unknown;
      }>(
        `select id, organization_id, active_version_id, trigger_config
           from followup_flow_pointers
          where organization_id = $1 and status = 'active' and active_version_id is not null`,
        [orgId],
      );
      const pointers: PointerDeEtapa[] = [];
      for (const row of rows) {
        if (!row.active_version_id) continue;
        const parsed = triggerConfigSchema.safeParse(row.trigger_config);
        if (!parsed.success || parsed.data.kind !== "stage_change") continue;
        pointers.push({
          id: row.id,
          organization_id: row.organization_id,
          active_version_id: row.active_version_id,
          stage_id: parsed.data.params.stage_id,
        });
      }
      return pointers;
    },
    async carregaContatoDoNegocio(orgId, leadId) {
      const { rows } = await pool.query<{ contact_id: string | null }>(
        `select contact_id from crm_leads where id = $1 and organization_id = $2`,
        [leadId, orgId],
      );
      return rows[0]?.contact_id ?? null;
    },
    async carregaNoDeGatilho(orgId, versionId) {
      const { rows } = await pool.query<{ graph: FlowGraph }>(
        `select graph from followup_flow_versions where organization_id = $1 and id = $2`,
        [orgId, versionId],
      );
      if (rows.length === 0) return null;
      return noDeGatilhoDoGrafo(rows[0]!.graph);
    },
    async insereEnrollment(input) {
      try {
        const { rows } = await pool.query<{ id: string }>(
          // ⚠️ ESPELHA O ADAPTER DE PRODUÇÃO: quando `next_eval_at` vem
          // ausente, a coluna é OMITIDA e o `default now()` do banco decide
          // (migration 0147). Um adapter de teste que preenchesse o campo
          // sozinho esconderia o defeito de relógio que a guarda mede.
          input.next_eval_at === undefined || input.next_eval_at === null
            ? `insert into followup_enrollments
                 (organization_id, pointer_id, version_id, contact_id, current_node_id, status, agent_id)
               values ($1, $2, $3, $4, $5, 'active', $6) returning id`
            : `insert into followup_enrollments
                 (organization_id, pointer_id, version_id, contact_id, current_node_id, status, agent_id, next_eval_at)
               values ($1, $2, $3, $4, $5, 'active', $6, $7) returning id`,
          [
            input.organization_id,
            input.pointer_id,
            input.version_id,
            input.contact_id,
            input.current_node_id,
            input.agent_id,
            ...(input.next_eval_at === undefined || input.next_eval_at === null ? [] : [input.next_eval_at]),
          ],
        );
        return { inserted: true, id: rows[0]!.id };
      } catch (err) {
        if ((err as { code?: string }).code === "23505") return { inserted: false, id: null };
        throw err;
      }
    },
    async insereEventoDoEnrollment(evento) {
      try {
        await pool.query(
          `insert into followup_enrollment_events
             (organization_id, enrollment_id, node_id, event_type, payload, idempotency_key)
           values ($1, $2, $3, $4, $5, $6)`,
          [
            evento.organization_id,
            evento.enrollment_id,
            evento.node_id,
            evento.event_type,
            JSON.stringify(evento.payload),
            evento.idempotency_key,
          ],
        );
      } catch (err) {
        if ((err as { code?: string }).code !== "23505") throw err;
      }
    },
  };
}

function pgGateDb(): FollowupGateDb {
  return {
    async loadEnabledPublishedFollowupAgents(orgId) {
      const { rows } = await pool.query<{ agent_id: string; followup: unknown }>(
        `select agent_id, followup from ai_agent_versions where organization_id = $1 and status = 'published'`,
        [orgId],
      );
      const byAgent = new Map<string, Set<string>>();
      for (const row of rows) {
        const f = row.followup as { enabled?: unknown; flow_pointer_ids?: unknown } | null;
        if (!f || f.enabled !== true || !Array.isArray(f.flow_pointer_ids)) continue;
        const set = byAgent.get(row.agent_id) ?? new Set<string>();
        for (const id of f.flow_pointer_ids) if (typeof id === "string") set.add(id);
        if (set.size > 0) byAgent.set(row.agent_id, set);
      }
      return [...byAgent].map(([agentId, ids]) => ({ agentId, pointerIds: [...ids] }));
    },
  };
}

let orgSeq = 0;
function nextOrgId(): string {
  orgSeq += 1;
  return `cccccc${String(orgSeq).padStart(2, "0")}-0000-4000-8000-000000000009`;
}

async function seedOrg(org: string): Promise<void> {
  const nome = `followup-reenroll-${org.slice(0, 8)}`;
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1, $2, $3, $4) on conflict (id) do nothing`,
    [org, nome, nome, nome],
  );
}

async function seedFunilComNegocio(
  org: string,
  contactId: string,
): Promise<{ etapaOrigem: string; etapaDestino: string; leadId: string }> {
  const marca = `${Date.now()}${Math.floor(Math.random() * 10_000)}`;
  const { rows: pipe } = await pool.query<{ id: string }>(
    `insert into crm_pipelines (organization_id, name, slug) values ($1, 'Funil', $2) returning id`,
    [org, `reenroll-${marca}`.slice(0, 40)],
  );
  const { rows: origem } = await pool.query<{ id: string }>(
    `insert into crm_stages (organization_id, pipeline_id, name, slug, position) values ($1, $2, 'Contato', $3, 1000) returning id`,
    [org, pipe[0]!.id, `reo-${marca}`.slice(0, 40)],
  );
  const { rows: destino } = await pool.query<{ id: string }>(
    `insert into crm_stages (organization_id, pipeline_id, name, slug, position) values ($1, $2, 'Proposta enviada', $3, 2000) returning id`,
    [org, pipe[0]!.id, `red-${marca}`.slice(0, 40)],
  );
  const { rows: lead } = await pool.query<{ id: string }>(
    `insert into crm_leads (organization_id, pipeline_id, stage_id, contact_id, title) values ($1, $2, $3, $4, 'Negócio') returning id`,
    [org, pipe[0]!.id, destino[0]!.id, contactId],
  );
  return { etapaOrigem: origem[0]!.id, etapaDestino: destino[0]!.id, leadId: lead[0]!.id };
}

let eventSeq = 0;
function eventoDeEtapa(org: string, leadId: string, de: string, para: string): EventRow {
  eventSeq += 1;
  return {
    id: `c0000000-0000-4000-8000-${String(eventSeq).padStart(12, "0")}`,
    organization_id: org,
    event_type: EVENTO_DE_ETAPA,
    entity_kind: "crm_lead",
    entity_id: leadId,
    payload: { from_stage_id: de, to_stage_id: para },
    metadata: {},
    consumed_by: [],
    attempts: 0,
  };
}

const deps = () => ({ db: gatilhoDb(), gateDb: pgGateDb(), clock: () => new Date() });

describe("re-entrada na fila depois que o follow-up terminou (comportamento congelado)", () => {
  it("contato cujo enrollment COMPLETOU é enrollado de novo no próximo movimento — hoje não há carência", async () => {
    const org = nextOrgId();
    await seedOrg(org);
    const { rows: contato } = await pool.query<{ id: string }>(
      `insert into contacts (organization_id, display_name) values ($1, 'Contato Reenroll') returning id`,
      [org],
    );
    const contactId = contato[0]!.id;
    const { etapaOrigem, etapaDestino, leadId } = await seedFunilComNegocio(org, contactId);

    const graph: FlowGraph = {
      nodes: [
        { id: "t1", type: "trigger", label: "Start", position: { x: 0, y: 0 }, config: {} },
        { id: "e1", type: "end", label: "Done", position: { x: 0, y: 0 }, config: { outcome: "converted" } },
      ],
      edges: [{ id: "t1-e1", source: "t1", target: "e1", priority: 0, condition: { type: "always" } }],
    };
    const { rows: version } = await pool.query<{ id: string }>(
      `insert into followup_flow_versions (organization_id, graph) values ($1, $2) returning id`,
      [org, JSON.stringify(graph)],
    );
    const { rows: pointer } = await pool.query<{ id: string }>(
      `insert into followup_flow_pointers (organization_id, name, status, active_version_id, trigger_config)
       values ($1, $2, 'active', $3, $4) returning id`,
      [
        org,
        `Reenroll Etapa ${Date.now()}-${Math.random()}`,
        version[0]!.id,
        JSON.stringify({ kind: "stage_change", params: { stage_id: etapaDestino } }),
      ],
    );
    const pointerId = pointer[0]!.id;
    pointersCriados.push(pointerId);

    const { rows: sess } = await pool.query<{ id: string }>(
      `insert into channel_sessions (organization_id, waha_session_name, status, webhook_secret_encrypted)
       values ($1, $2, 'WORKING', '\\x00'::bytea) returning id`,
      [org, `reenroll-${Date.now()}-${Math.random()}`],
    );
    const { rows: agent } = await pool.query<{ id: string }>(
      `insert into ai_agents (organization_id, name, system_prompt) values ($1, $2, 'prompt') returning id`,
      [org, `Agente Reenroll ${Date.now()}-${Math.random()}`],
    );
    await pool.query(
      `insert into ai_agent_versions
         (organization_id, agent_id, version_number, system_prompt, provider, model, channel_session_id, status, followup)
       values ($1, $2, 1, 'prompt', 'anthropic', 'claude-sonnet-4-6', $3, 'published', $4)`,
      [org, agent[0]!.id, sess[0]!.id, JSON.stringify({ enabled: true, flow_pointer_ids: [pointerId] })],
    );

    // 1ª entrada na fila.
    const primeira = await aplicaGatilhoDeEtapa(deps(), eventoDeEtapa(org, leadId, etapaOrigem, etapaDestino));
    expect(primeira.enrolled).toBe(1);

    // Enquanto VIVO, o índice org-wide barra — isto é o que garante que não há laço.
    const durante = await aplicaGatilhoDeEtapa(deps(), eventoDeEtapa(org, leadId, etapaOrigem, etapaDestino));
    expect(durante.enrolled).toBe(0);
    expect(durante.skipped_existing).toBe(1);

    // O follow-up chega ao fim, como chegaria em produção.
    await pool.query(
      `update followup_enrollments
          set status = 'completed', outcome = 'converted', completed_at = now(), next_eval_at = null
        where organization_id = $1 and contact_id = $2`,
      [org, contactId],
    );

    // 2ª entrada: o MESMO contato volta à fila no próximo movimento qualificante.
    //
    // ⚠️ ESTA É A LINHA. Se você chegou aqui porque ela ficou vermelha, alguém
    // adicionou carência entre um follow-up que terminou e o próximo — leia o
    // cabeçalho antes de "consertar" o teste: o comportamento congelado aqui é
    // deliberado, e mudá-lo é uma decisão de produto, não um ajuste de teste.
    const depois = await aplicaGatilhoDeEtapa(deps(), eventoDeEtapa(org, leadId, etapaOrigem, etapaDestino));
    expect(depois.enrolled).toBe(1);

    // `started_at`, e não `created_at`: esta tabela não tem `created_at` — o
    // relógio dela é `started_at`/`completed_at`/`updated_at`. Ordenar pela
    // coluna errada não devolve ordem errada, devolve ERRO, e foi assim que este
    // teste reprovou na primeira execução mesmo com o congelamento funcionando.
    const { rows: finais } = await pool.query<{ status: string }>(
      `select status from followup_enrollments where pointer_id = $1 and contact_id = $2 order by started_at`,
      [pointerId, contactId],
    );
    expect(finais.map((r) => r.status)).toEqual(["completed", "active"]);
  });
});
