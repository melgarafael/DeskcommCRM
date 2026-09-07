import { criarOrigemDeFollowup } from "./followup-service-origin";
import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";

import { runFollowupTick, type FollowupJobRequest, type TickDeps } from "@/lib/followup/engine";
import { completeTurnForEnrollment, createPgAdminClient } from "@/lib/followup/turn-bridge";
import type { FlowGraph } from "@/lib/followup/graph-schema";

/**
 * A PAUSA MANUAL CONTRA POSTGRES DE VERDADE (migration 0145).
 *
 * Quatro propriedades, e cada uma existe porque a ausência dela é silenciosa:
 *
 *  1. o banco aceita `paused_manual` sem relógio — e continua recusando `active`
 *     sem relógio (a coerência que a 0054 criou não foi afrouxada de carona);
 *  2. `fn_claim_due_followup_enrollments` deixa de ver o pausado. É o que faz a
 *     pausa PARAR o fluxo: sem isso a tela diria "pausado" e o worker seguiria
 *     mandando mensagem;
 *  3. o pausado continua ocupando a vaga de "vivo" do par (ORGANIZAÇÃO,
 *     contato) — nem em outro fluxo nasce um segundo. Se a liberasse, dois
 *     follow-ups andariam juntos sobre a mesma pessoa no instante da retomada;
 *  4. um turno que termina DEPOIS da pausa é descartado. Esta é a metade da
 *     corrida que mora no `turn-bridge.ts`, e o teste vem com CONTROLE POSITIVO
 *     (o mesmo turno, num enrollment ativo, avança) — sem ele, um bug que
 *     fizesse `completeTurnForEnrollment` nunca avançar nada passaria verde.
 *
 * Roda contra o adapter pg-puro de PRODUÇÃO (`createPgAdminClient`), o mesmo que
 * `workers/agent-worker/main.ts` usa — não um duplicado de teste.
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

afterAll(async () => {
  await pool.end();
});

const db = createPgAdminClient(pool);

const GRAFO: FlowGraph = {
  nodes: [
    {
      id: "acao",
      type: "action",
      label: "Cutucada",
      position: { x: 0, y: 0 },
      config: { mode: "ai_message", prompt_hint: "lembre do orçamento" },
    },
    { id: "fim", type: "end", label: "Fim", position: { x: 0, y: 0 }, config: { outcome: "converted" } },
  ],
  edges: [{ id: "acao-fim", source: "acao", target: "fim", priority: 0, condition: { type: "always" } }],
};

interface Cenario {
  org: string;
  contactId: string;
  pointerId: string;
  versionId: string;
}

async function montaCenario(rotulo: string): Promise<Cenario> {
  // Os três parâmetros repetem o MESMO valor de propósito, em vez de `$1` três
  // vezes: `slug` é `citext` e os outros dois são `text`, e o Postgres recusa a
  // dedução ("inconsistent types deduced for parameter $1") quando um parâmetro
  // só é usado nas duas posições.
  const nome = `intervencao-${rotulo}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const { rows: orgRows } = await pool.query<{ id: string }>(
    `insert into organizations (slug, legal_name, display_name)
     values ($1, $2, $3) returning id`,
    [nome, nome, nome],
  );
  const org = orgRows[0]!.id;

  const { rows: contactRows } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, display_name) values ($1, 'Cliente da pausa') returning id`,
    [org],
  );
  const { rows: versionRows } = await pool.query<{ id: string }>(
    `insert into followup_flow_versions (organization_id, graph) values ($1, $2) returning id`,
    [org, JSON.stringify(GRAFO)],
  );
  const versionId = versionRows[0]!.id;
  const { rows: pointerRows } = await pool.query<{ id: string }>(
    `insert into followup_flow_pointers (organization_id, name, status, active_version_id)
     values ($1, $2, 'active', $3) returning id`,
    [org, `Fluxo ${rotulo} ${Date.now()}-${Math.random()}`, versionId],
  );

  return { org, contactId: contactRows[0]!.id, pointerId: pointerRows[0]!.id, versionId };
}

async function criaEnrollment(
  c: Cenario,
  opts: { status?: string; comRelogio?: boolean; contactId?: string; stepsTaken?: number } = {},
): Promise<string> {
  const status = opts.status ?? "active";
  const relogio = opts.comRelogio ?? true;
  const boundary = await criarOrigemDeFollowup(pool, c.org, opts.contactId ?? c.contactId);
  const { rows } = await pool.query<{ id: string }>(
    `insert into followup_enrollments
       (organization_id, pointer_id, version_id, contact_id, current_node_id, status, next_eval_at, steps_taken, conversation_id, service_boundary)
     values ($1, $2, $3, $4, 'acao', $5, case when $6 then now() - interval '1 second' else null end, $7, $8, $9::jsonb)
     returning id`,
    [c.org, c.pointerId, c.versionId, opts.contactId ?? c.contactId, status, relogio, opts.stepsTaken ?? 0, boundary.conversation_id, JSON.stringify(boundary)],
  );
  return rows[0]!.id;
}

async function leEnrollment(id: string): Promise<Record<string, unknown>> {
  const { rows } = await pool.query(`select * from followup_enrollments where id = $1`, [id]);
  return rows[0]!;
}

function tickDeps(jobs: FollowupJobRequest[]): TickDeps {
  return { db, clock: () => new Date(), enqueueJob: async (job) => void jobs.push(job) };
}

describe("pausa manual — o que o banco garante", () => {
  it("aceita paused_manual sem relógio, e continua recusando ativo sem relógio", async () => {
    const c = await montaCenario("check");
    const id = await criaEnrollment(c, { status: "paused_manual", comRelogio: false });
    expect((await leEnrollment(id)).status).toBe("paused_manual");

    // A coerência da 0054 não foi afrouxada de carona pela 0145: estado COM
    // relógio segue exigindo `next_eval_at`.
    await expect(
      pool.query(
        `insert into followup_enrollments
           (organization_id, pointer_id, version_id, contact_id, current_node_id, status, next_eval_at)
         values ($1, $2, $3, $4, 'acao', 'active', null)`,
        [c.org, c.pointerId, c.versionId, c.contactId],
      ),
    ).rejects.toThrow(/violates check constraint/i);
  });

  it("o claim do worker deixa de ver o enrollment pausado", async () => {
    const c = await montaCenario("claim");
    const pausado = await criaEnrollment(c, { status: "paused_manual", comRelogio: false });

    // Segundo contato: o vencido de verdade. Ele PRECISA ser reclamado, senão o
    // teste passaria por o claim não estar devolvendo nada (vacuidade).
    const { rows: outro } = await pool.query<{ id: string }>(
      `insert into contacts (organization_id, display_name) values ($1, 'Cliente vencido') returning id`,
      [c.org],
    );
    const vencido = await criaEnrollment(c, { contactId: outro[0]!.id });

    const reclamados = await db.claimDueEnrollments(50, 120);
    const ids = reclamados.map((e) => e.id);
    expect(ids).toContain(vencido);
    expect(ids).not.toContain(pausado);
  });

  /**
   * ⚠️ O SEGUNDO ENROLLMENT NASCE EM OUTRO FLUXO, E É ISSO QUE O TESTE MEDE.
   *
   * A versão anterior reusava o mesmo `pointer_id`, e assim ela passava com
   * QUALQUER um dos dois predicados possíveis — o `(pointer_id, contact_id)` da
   * DDL original e o `(organization_id, contact_id)` que está em vigor. Passava
   * por sorte: a 0145 recriou o índice copiando a definição ERRADA (revertendo
   * "um vivo por contato na organização" para "um por fluxo"), e este teste
   * ficou verde em cima do defeito.
   *
   * Com dois fluxos e o mesmo contato, só o predicado CERTO recusa a segunda
   * linha — e a diferença entre os dois deixa de ser invisível.
   */
  it("pausado ocupa a vaga do contato na ORGANIZAÇÃO — nem em outro fluxo nasce um segundo", async () => {
    const c = await montaCenario("unico");
    await criaEnrollment(c, { status: "paused_manual", comRelogio: false });

    const { rows: outraVersao } = await pool.query<{ id: string }>(
      `insert into followup_flow_versions (organization_id, graph) values ($1, $2) returning id`,
      [c.org, JSON.stringify(GRAFO)],
    );
    const { rows: outroPointer } = await pool.query<{ id: string }>(
      `insert into followup_flow_pointers (organization_id, name, status, active_version_id)
       values ($1, $2, 'active', $3) returning id`,
      [c.org, `Outro fluxo ${Date.now()}-${Math.random()}`, outraVersao[0]!.id],
    );

    await expect(
      criaEnrollment(
        { ...c, pointerId: outroPointer[0]!.id, versionId: outraVersao[0]!.id },
        { status: "active" },
      ),
    ).rejects.toThrow(/idx_followup_enrollments_one_live|duplicate key/i);
  });
});

describe("o turno que termina depois da pausa", () => {
  it("NÃO avança nem reativa o enrollment pausado por uma pessoa", async () => {
    const c = await montaCenario("stale");
    const id = await criaEnrollment(c, { status: "paused_manual", comRelogio: false });

    // O resultado do turno foi calculado ANTES de a pessoa pausar; aplicá-lo
    // desfaria a decisão dela em silêncio.
    await completeTurnForEnrollment(db, c.org, id, "acao", { kind: "sent" });

    const depois = await leEnrollment(id);
    expect(depois.status).toBe("paused_manual");
    expect(depois.current_node_id).toBe("acao");
    expect(depois.next_eval_at).toBeNull();
  });

  it("CONTROLE POSITIVO: o mesmo turno, num enrollment que está andando, avança", async () => {
    const c = await montaCenario("controle");
    const id = await criaEnrollment(c, { status: "active" });

    await completeTurnForEnrollment(db, c.org, id, "acao", { kind: "sent" });

    const depois = await leEnrollment(id);
    expect(depois.current_node_id).toBe("fim");
    expect(depois.status).toBe("active");
  });
});

describe("o tick do motor", () => {
  it("passa reto pelo pausado e trabalha o que está vencido", async () => {
    const c = await montaCenario("tick");
    const pausado = await criaEnrollment(c, { status: "paused_manual", comRelogio: false });

    const jobs: FollowupJobRequest[] = [];
    await runFollowupTick(tickDeps(jobs), { limit: 50 });

    const depois = await leEnrollment(pausado);
    expect(depois.status).toBe("paused_manual");
    expect(depois.steps_taken).toBe(0);
    expect(jobs.some((j) => j.payload.followup_enrollment_id === pausado)).toBe(false);
  });
});
