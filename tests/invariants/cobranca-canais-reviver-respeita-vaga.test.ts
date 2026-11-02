import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";
import { assinar, chaveDeCobranca, criarOrg, criarPlano, criarUsuarios, erroDe, uuid, valor } from "./cobranca-helpers";

/**
 * REVIVER UMA CONEXÃO SEM NÚMERO RESPEITA A VAGA DO PLANO (migration 9036).
 *
 * A 0809 tirou da contagem a linha morta e sem número (`FAILED`/`STOPPED`,
 * `phone_number` nulo). A vaga é conferida na criação da linha; os dois
 * caminhos que trazem uma linha morta de volta só trocam o `status`:
 *
 *   · o "Reconectar" — a rota chama `fn_vaga_ao_reviver_canal` antes de tocar
 *     o transporte;
 *   · os ramos de reuso de `fn_reserve_channel_connection` (linha de
 *     onboarding existente, recibo retomado) — a reserva chama a mesma função.
 *
 * A régua: a linha que deixou de ocupar só volta a ocupar se houver vaga. O
 * número que já é da empresa (pareado, `FAILED` inclusive) passa direto, mesmo
 * acima do teto.
 */

const P = "c0b00009-0000-4000-8000";
const org = (n: number) => uuid(P, n);
const canal = (n: number) => uuid(P, 100 + n);
const ADMIN = uuid(P, 800);
const PLANO_1 = uuid(P, 901);

type Estado = "STARTING" | "SCAN_QR_CODE" | "WORKING" | "STOPPED" | "FAILED";

function insercaoDeCanal(
  id: string,
  orgId: string,
  opcoes: { estado: Estado; telefone?: string | null; onboarding?: boolean },
): string {
  const telefone = opcoes.telefone ?? null;
  const metadata = opcoes.onboarding ? `'{"onboarding":true}'::jsonb` : "default";
  return `insert into public.channel_sessions
    (id, organization_id, waha_session_name, webhook_secret_encrypted, status, phone_number, metadata)
    values ('${id}', '${orgId}', 'rev-${id.slice(-12)}', '\\x00'::bytea, '${opcoes.estado}',
            ${telefone === null ? "null" : `'${telefone}'`}, ${metadata})`;
}

function statusDe(id: string): string {
  return valor(`select status from public.channel_sessions where id = '${id}';`);
}

/** O caminho do "Reconectar": a rota chama como servidor. */
function reviver(orgId: string, id: string): string {
  return erroDe(`set role service_role; select public.fn_vaga_ao_reviver_canal('${orgId}', '${id}');`);
}

/** A reserva como o PostgREST a chama: `authenticated` com o JWT do admin. */
function reservar(orgId: string, chave: string, onboarding: boolean): string {
  return `set role authenticated;
select set_config('request.jwt.claims', '{"sub":"${ADMIN}","role":"authenticated","aal":"aal1"}', false);
select public.fn_reserve_channel_connection('${orgId}', '${chave}', '${"a".repeat(64)}', null, ${onboarding});`;
}

beforeAll(() => {
  criarPlano({ id: PLANO_1, nome: "Um número conectado", maxCanais: 1 });
  criarUsuarios([[ADMIN, "reviver-vaga@invariant.test"]]);
  for (let n = 1; n <= 6; n++) {
    criarOrg(org(n), `cob-reviver-${n}`);
    sql(`insert into public.user_organizations (organization_id, user_id, role, accepted_at)
           values ('${org(n)}', '${ADMIN}', 'admin', now()) on conflict do nothing;`);
    assinar(org(n), PLANO_1);
  }
  chaveDeCobranca("ligado");
});

describe("inv. 6c — reviver a linha morta e sem número confere a vaga (9036)", () => {
  it("⭐ Reconectar: com a vaga tomada por outro número, PT402 — e a linha continua morta", () => {
    sql(`${insercaoDeCanal(canal(1), org(1), { estado: "FAILED" })};
         ${insercaoDeCanal(canal(2), org(1), { estado: "WORKING", telefone: "5511910000002" })};`);
    const e = reviver(org(1), canal(1));
    expect(e).toContain("PT402");
    expect(e).toContain("limite_do_plano:canais:1");
    expect(statusDe(canal(1))).toBe("FAILED");
  });

  it("⭐ Reconectar com vaga livre: a vaga é TOMADA na hora, e a criação seguinte já é recusada", () => {
    sql(`${insercaoDeCanal(canal(3), org(2), { estado: "FAILED" })};`);
    expect(reviver(org(2), canal(3))).toBe("");
    expect(statusDe(canal(3))).toBe("STARTING");
    expect(erroDe(`${insercaoDeCanal(canal(4), org(2), { estado: "WORKING", telefone: "5511910000004" })};`))
      .toContain("limite_do_plano:canais:1");
  });

  it("CONTROLE: número pareado que caiu reconecta mesmo acima do teto — a conferência não o vê", () => {
    sql(`${insercaoDeCanal(canal(5), org(3), { estado: "FAILED", telefone: "5511910000005" })};`);
    try {
      chaveDeCobranca("desligado");
      sql(`${insercaoDeCanal(canal(6), org(3), { estado: "WORKING", telefone: "5511910000006" })};`);
    } finally {
      chaveDeCobranca("ligado");
    }
    expect(reviver(org(3), canal(5))).toBe("");
    // Nada foi tomado: o status é de quem fala com o transporte (a rota).
    expect(statusDe(canal(5))).toBe("FAILED");
  });

  it("⭐ reserva de onboarding que REUSA a linha morta: PT402 com a vaga tomada", () => {
    sql(`${insercaoDeCanal(canal(7), org(4), { estado: "FAILED", onboarding: true })};
         ${insercaoDeCanal(canal(8), org(4), { estado: "WORKING", telefone: "5511910000008" })};`);
    const e = erroDe(reservar(org(4), uuid(P, 704), true));
    expect(e).toContain("limite_do_plano:canais:1");
    expect(statusDe(canal(7))).toBe("FAILED");
  });

  it("⭐ reserva retomada pelo recibo: a linha que morreu sem número não volta sem vaga", () => {
    const chave = uuid(P, 705);
    const primeira = JSON.parse(valor(reservar(org(5), chave, false))) as {
      channel: { id: string };
      receipt_id: string;
      lease_token: string;
    };
    sql(`select public.fn_finish_channel_connection('${org(5)}', '${primeira.receipt_id}', '${primeira.lease_token}',
           'FAILED', 'connection_repair_required');`);
    expect(statusDe(primeira.channel.id)).toBe("FAILED");
    // A linha morta não ocupa (0809): o número seguinte entra.
    sql(`${insercaoDeCanal(canal(9), org(5), { estado: "WORKING", telefone: "5511910000009" })};`);
    const e = erroDe(reservar(org(5), chave, false));
    expect(e).toContain("limite_do_plano:canais:1");
    expect(statusDe(primeira.channel.id)).toBe("FAILED");
  });

  it("a reserva com vaga livre segue igual, e a função não é RPC de quem está logado", () => {
    const r = JSON.parse(valor(reservar(org(6), uuid(P, 706), false))) as { channel: { status: string } };
    expect(r.channel.status).toBe("STARTING");
    for (const papel of ["anon", "authenticated"]) {
      expect(
        valor(`select has_function_privilege('${papel}', 'public.fn_vaga_ao_reviver_canal(uuid,uuid)', 'execute');`),
        papel,
      ).toBe("f");
    }
    expect(
      sql(`select pg_get_functiondef('public.fn_reserve_channel_connection(uuid,uuid,text,text,boolean)'::regprocedure);`),
    ).toContain("fn_vaga_ao_reviver_canal(p_org,channel.id)");
  });
});
