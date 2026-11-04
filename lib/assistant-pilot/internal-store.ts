import { createHash } from "node:crypto";
import type pg from "pg";
import { assertPilotIdentity } from "./domain";
import type { PilotIdentity, PilotSession } from "./types";

export async function assertMembership(db: pg.Pool | pg.PoolClient, i: PilotIdentity) {
  assertPilotIdentity(i);
  const r = await db.query(
    `select 1 from user_organizations u join organizations o on o.id=u.organization_id
    where u.organization_id=$1 and u.user_id=$2 and u.accepted_at is not null and u.revoked_at is null and o.status='active'`,
    [i.tenantId, i.userId],
  );
  if (!r.rowCount) throw new Error("pilot_membership_denied");
}
export async function getInternalSession(
  db: pg.Pool | pg.PoolClient,
  i: PilotIdentity,
): Promise<PilotSession> {
  await assertMembership(db, i);
  const s = (
    await db.query(
      "select id from personal_assistant_sessions where organization_id=$1 and user_id=$2 and assistant_id=$3",
      [i.tenantId, i.userId, i.assistantId],
    )
  ).rows[0];
  const rows = s
    ? (
        await db.query(
          `select * from (select * from personal_assistant_turns where session_id=$1 and organization_id=$2 and user_id=$3 and assistant_id=$4 and expires_at>now() order by created_at desc,id desc limit 40) t order by created_at,id`,
          [s.id, i.tenantId, i.userId, i.assistantId],
        )
      ).rows
    : [];
  return {
    id: s?.id ?? `${i.tenantId}:${i.userId}:${i.assistantId}`,
    identity: i,
    version: rows.length,
    updatedAt: rows.at(-1)?.created_at.toISOString() ?? new Date().toISOString(),
    messages: rows.flatMap((r) => [
      {
        id: `${r.id}:user`,
        role: "user" as const,
        text: r.user_text,
        channel: "crm" as const,
        createdAt: r.created_at.toISOString(),
      },
      ...(r.status === "completed"
        ? [
            {
              id: `${r.id}:assistant`,
              role: "assistant" as const,
              text: r.assistant_text,
              channel: "crm" as const,
              createdAt: r.completed_at.toISOString(),
            },
          ]
        : []),
    ]),
    receipts: rows.map((r) => ({
      id: r.id,
      turnId: r.id,
      operation: "conversation" as const,
      status: r.status === "completed" ? ("completed" as const) : ("failed" as const),
      targetIds: [],
      channel: "crm" as const,
      createdAt: r.created_at.toISOString(),
      ...(r.status !== "completed"
        ? {
            error:
              r.status === "reserved"
                ? "Turno em andamento ou resultado incerto; não reenviado."
                : "Falha no motor; nada de negócio executado.",
          }
        : {}),
    })),
  };
}
export async function reserveInternalTurn(
  db: pg.Pool,
  i: PilotIdentity,
  id: string,
  text: string,
): Promise<boolean> {
  const c = await db.connect();
  try {
    await c.query("begin");
    await assertMembership(c, i);
    await c.query(
      `insert into personal_assistant_sessions(organization_id,user_id,assistant_id) values($1,$2,$3) on conflict(organization_id,user_id,assistant_id) do nothing`,
      [i.tenantId, i.userId, i.assistantId],
    );
    const s = (
      await c.query(
        `select id from personal_assistant_sessions where organization_id=$1 and user_id=$2 and assistant_id=$3 for update`,
        [i.tenantId, i.userId, i.assistantId],
      )
    ).rows[0];
    const hash = createHash("sha256").update(text).digest("hex");
    const prior = (
      await c.query(
        "select session_id,request_hash,status from personal_assistant_turns where id=$1",
        [id],
      )
    ).rows[0];
    if (prior) {
      if (prior.session_id !== s.id || prior.request_hash !== hash)
        throw new Error("turn_identity_conflict");
      if (prior.status !== "completed") throw new Error("turn_uncertain");
      await c.query("commit");
      return false;
    }
    if (
      (
        await c.query(
          "select 1 from personal_assistant_turns where session_id=$1 and status='reserved'",
          [s.id],
        )
      ).rowCount
    )
      throw new Error("session_busy_or_uncertain");
    // Expired transcript is excluded from reads. No deletion during this pilot.
    await c.query(
      `insert into personal_assistant_turns(id,session_id,organization_id,user_id,assistant_id,request_hash,user_text,status) values($1,$2,$3,$4,$5,$6,$7,'reserved')`,
      [id, s.id, i.tenantId, i.userId, i.assistantId, hash, text],
    );
    await c.query("commit");
    return true;
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}
export async function finishInternalTurn(
  db: pg.Pool,
  i: PilotIdentity,
  id: string,
  text: string | null,
) {
  await assertMembership(db, i);
  const r = await db.query(
    `update personal_assistant_turns set status=$5,assistant_text=$6,completed_at=now() where id=$1 and organization_id=$2 and user_id=$3 and assistant_id=$4 and status='reserved'`,
    [id, i.tenantId, i.userId, i.assistantId, text === null ? "failed" : "completed", text],
  );
  if (r.rowCount !== 1) throw new Error("turn_not_completed");
}
