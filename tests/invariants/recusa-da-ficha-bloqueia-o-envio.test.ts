import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { patchContactHandler } from "@/app/api/v1/contacts/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { checarGuardasDeContato } from "@/lib/automation/guarda-do-contato";
import { buildContext } from "@/lib/automation/engine";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { buildContactConsentDenial } from "@/lib/webhooks/respondi";

import { pgComoSupabase } from "../pg-como-supabase";

/**
 * A RECUSA GRAVADA PELA FICHA BLOQUEIA O ENVIO.
 *
 * A ficha do contato grava a revogação como `{ granted: false }`; a captação, como `declined_at`. A guarda de envio da
 * automação lia só `declined_at`, e quem a empresa registrou pela ficha que disse não seguia recebendo.
 *
 * Contra Postgres real, pelo caminho inteiro: a revogação entra pelo handler da ficha (`patchContactHandler`, o merge por
 * finalidade), o motor monta o contato do contexto como monta para uma regra (`buildContext`, `select *` em `contacts`), e
 * a guarda de verdade decide. `pgComoSupabase` troca só o transporte.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`, max: 3 });
const db = pgComoSupabase(pool);

const ORG_A = "f2ec0000-0000-4000-8000-000000000001";
const ORG_B = "f2ec0000-0000-4000-8000-000000000002";
const USUARIO = "f2ec0000-0000-4000-8000-0000000000a1";

function ctx(org: string): HandlerCtx {
  return { organization_id: org, actor: { type: "user", id: USUARIO }, requestId: "req-f2" };
}

async function criarContato(org: string, consent?: Record<string, unknown>): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, display_name, source, phone_number${consent ? ", consent" : ""})
     values ($1, 'Alvo da recusa', 'manual', '+55119' || lpad((floor(random() * 1e7))::int::text, 8, '0')${consent ? ", $2" : ""})
     returning id`,
    consent ? [org, JSON.stringify(consent)] : [org],
  );
  return rows[0]!.id;
}

/** O contato como o MOTOR o monta para uma regra, e a guarda que toda ação de mensagem chama. */
async function guardaDoMotor(org: string, contato: string) {
  const row = {
    id: "evt-f2",
    organization_id: org,
    event_type: "contact.updated",
    entity_kind: "contact",
    entity_id: contato,
    payload: {},
    metadata: {},
    consumed_by: [],
    attempts: 0,
  } as EventRow;
  const context = await buildContext(db, row);
  return checarGuardasDeContato({ context } as never);
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values
       ($1, 'org-f2-a', 'Recusa F2 A', 'F2 A'), ($2, 'org-f2-b', 'Recusa F2 B', 'F2 B')
     on conflict (id) do nothing`,
    [ORG_A, ORG_B],
  );
});

afterAll(async () => {
  await pool.query("delete from organizations where id in ($1, $2)", [ORG_A, ORG_B]);
  await pool.end();
});

describe("a recusa gravada pela ficha bloqueia o envio", () => {
  it("a ficha revoga (`granted: false`): o motor monta o contato e a guarda recusa com `consent_declined`", async () => {
    const id = await criarContato(ORG_A, { marketing: { granted: true, granted_at: "2026-01-01T00:00:00Z" } });
    expect((await guardaDoMotor(ORG_A, id)).ok, "controle: antes da revogação, a guarda deixa passar").toBe(true);

    await patchContactHandler(db, ctx(ORG_A), id, { consent: { marketing: { granted: false, granted_at: null } } } as never);

    expect(await guardaDoMotor(ORG_A, id)).toEqual({ ok: false, reason: "consent_declined" });
  });

  it("a recusa da captação (`declined_at`, o formato de `buildContactConsentDenial`) segue bloqueando", async () => {
    const id = await criarContato(ORG_A);
    await pool.query("update contacts set consent = $1 where id = $2 and organization_id = $3", [
      JSON.stringify(buildContactConsentDenial("form-teste")),
      id,
      ORG_A,
    ]);
    expect(await guardaDoMotor(ORG_A, id)).toEqual({ ok: false, reason: "consent_declined" });
  });

  it("o que NÃO é recusa: o default da coluna (ninguém perguntou) e `granted: null` deixam passar", async () => {
    const padrao = await criarContato(ORG_A);
    expect((await guardaDoMotor(ORG_A, padrao)).ok).toBe(true);

    const nulo = await criarContato(ORG_A, { marketing: { granted: null, granted_at: null } });
    expect((await guardaDoMotor(ORG_A, nulo)).ok).toBe(true);
  });

  it("a ficha concede de novo (`granted: true`) depois de revogar: a guarda volta a deixar passar", async () => {
    const id = await criarContato(ORG_A, { marketing: { granted: false, granted_at: null } });
    expect((await guardaDoMotor(ORG_A, id)).ok).toBe(false);
    await patchContactHandler(db, ctx(ORG_A), id, {
      consent: { marketing: { granted: true, granted_at: "2026-11-09T00:00:00Z" } },
    } as never);
    expect((await guardaDoMotor(ORG_A, id)).ok).toBe(true);
  });

  it("isolamento entre duas empresas: o motor de A não monta o contato de B, e a revogação em B não toca A", async () => {
    const deB = await criarContato(ORG_B, { marketing: { granted: false } });
    expect(await guardaDoMotor(ORG_A, deB)).toEqual({ ok: false, reason: "no_contact" });

    const deA = await criarContato(ORG_A, { marketing: { granted: true } });
    await patchContactHandler(db, ctx(ORG_B), deA, { consent: { marketing: { granted: false } } } as never).catch(() => null);
    expect((await guardaDoMotor(ORG_A, deA)).ok, "a ficha de B não alcança o contato de A").toBe(true);
  });
});
