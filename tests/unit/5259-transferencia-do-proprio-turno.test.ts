/**
 * #5259 — a atribuição que o PRÓPRIO turno fez não conta como "uma pessoa assumiu".
 *
 * O agente transfere com `crm_assign_conversation` e, em seguida, avisa o cliente.
 * `fn_conversation_assign` grava, na mesma transação, o dono humano
 * (`assignee_kind = 'user'`) E o silêncio sem prazo (`bot_silenced_until =
 * 'infinity'`) — as duas travas que `iaVetadaNoEnvio` lê. Sem distinguir quem
 * atribuiu, o aviso de transferência era recusado com `pessoa_assumiu_a_conversa`
 * e o cliente ficava sem resposta nenhuma.
 *
 * A distinção mora no banco: o evento de atribuição carrega `source_job_id`, que
 * só o runtime grava (#3926). O veto cai SOMENTE quando a última atribuição da
 * conversa é deste turno, o dono é o que ela gravou e nenhuma pessoa falou na
 * conversa desde que o turno começou. O comportamento de ponta a ponta (turno
 * real, banco real) é medido em `tests/invariants/pessoa-assume-durante-o-turno.test.ts`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import { iaVetadaNoEnvio } from "@/lib/agent-engine/agent/human-handoff";

const ORG = "aaaaaaaa-5259-4000-8000-000000000001";
const CONTATO = "aaaaaaaa-5259-4000-8000-000000000002";
const CONV = "aaaaaaaa-5259-4000-8000-000000000003";
const JOB = "aaaaaaaa-5259-4000-8000-000000000004";

/**
 * O estado logo depois da transferência: silêncio em vigor e dono humano.
 * `doProprioTurno` é o que a leitura da atribuição devolve.
 */
function bancoDepoisDaTransferencia(doProprioTurno: boolean | null) {
  const consultas: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    query: vi.fn(async (sql: string, params: unknown[]) => {
      consultas.push({ sql, params });
      if (sql.includes("conversation_assignment_events")) {
        return { rows: doProprioTurno === null ? [] : [{ do_proprio_turno: doProprioTurno }], rowCount: 1 };
      }
      if (sql.includes("as handoff")) return { rows: [{ handoff: true }], rowCount: 1 };
      return { rows: [{ assignee_kind: "user", metadata: {} }], rowCount: 1 };
    }),
  } as unknown as pg.Pool;
  return { db, consultas };
}

describe("#5259 — a transferência feita pelo próprio turno não veta o aviso ao cliente", () => {
  // SABOTAGEM: tirar a leitura da atribuição de `iaVetadaNoEnvio` → devolve true.
  it("⭐ a última atribuição é deste turno: o aviso de transferência sai", async () => {
    const { db } = bancoDepoisDaTransferencia(true);
    expect(await iaVetadaNoEnvio(db, ORG, CONTATO, CONV, { jobDoTurno: JOB })).toBe(false);
  });

  it("a atribuição é de outro ator (ou o dono mudou depois): continua vetada", async () => {
    const { db } = bancoDepoisDaTransferencia(false);
    expect(await iaVetadaNoEnvio(db, ORG, CONTATO, CONV, { jobDoTurno: JOB })).toBe(true);
  });

  it("conversa sem evento de atribuição: continua vetada", async () => {
    const { db } = bancoDepoisDaTransferencia(null);
    expect(await iaVetadaNoEnvio(db, ORG, CONTATO, CONV, { jobDoTurno: JOB })).toBe(true);
  });

  it("sem o job do turno, a regra é a de antes: veta, e nem consulta a atribuição", async () => {
    const { db, consultas } = bancoDepoisDaTransferencia(true);
    expect(await iaVetadaNoEnvio(db, ORG, CONTATO, CONV)).toBe(true);
    expect(consultas.some((c) => c.sql.includes("conversation_assignment_events"))).toBe(false);
  });

  it("conversa livre: nem consulta a atribuição", async () => {
    const respostas = [{ handoff: false }, { assignee_kind: "ai", metadata: {} }];
    const query = vi.fn(async () => ({ rows: [respostas.shift()], rowCount: 1 }));
    expect(await iaVetadaNoEnvio({ query } as unknown as pg.Pool, ORG, CONTATO, CONV, { jobDoTurno: JOB })).toBe(false);
    expect(query).toHaveBeenCalledTimes(2);
  });

  // A régua da leitura, cláusula por cláusula. SABOTAGENS que cada expect acusa:
  // tirar o job, o "dono é o que ela gravou", a fala humana, as travas do contato
  // ou o recorte por organização.
  it("a leitura amarra job, dono, fala humana, travas do contato e organização", async () => {
    const { db, consultas } = bancoDepoisDaTransferencia(true);
    await iaVetadaNoEnvio(db, ORG, CONTATO, CONV, { jobDoTurno: JOB });
    const leitura = consultas.find((c) => c.sql.includes("conversation_assignment_events"))!;
    expect(leitura.params).toEqual([ORG, CONTATO, CONV, JOB]);
    const sql = leitura.sql.replace(/\s+/g, " ");
    expect(sql).toContain("e.source_job_id = $4");
    expect(sql).toContain("e.to_user_id = v.assigned_to_user_id");
    expect(sql).toContain("v.assignee_kind = 'user'");
    expect(sql).toContain("order by e.created_at desc");
    expect(sql).toContain("m.sent_via in ('user', 'crm', 'external_device')");
    expect(sql).toContain("not c.force_human");
    expect(sql).toContain("not c.ai_opt_out");
    expect(sql).toContain("e.organization_id = $1");
    expect(sql).toContain("v.organization_id = $1");
    expect(sql).toContain("m.organization_id = $1");
  });

  it("a guarda do turno passa o job dele", () => {
    const fonte = readFileSync(join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts"), "utf8");
    const i = fonte.indexOf("const pessoaAssumiuDuranteOTurno = async");
    const corpo = fonte.slice(i, fonte.indexOf("};", i));
    expect(corpo).toContain("iaVetadaNoEnvio(pool, tenantId, leadId, input.conversationId, { jobDoTurno: liveJob().id })");
  });
});
