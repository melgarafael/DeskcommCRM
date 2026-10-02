import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";
import {
  assinar, comoAnon, comoServidor, comoUsuario, criarOrg, criarPlano, criarUsuarios, erroDe, eventos, numero, resultado,
  uuid, valor, vincular,
} from "./cobranca-helpers";

/**
 * A SUSPENSÃO POR COBRANÇA E A SAÍDA DELA (migration 0510; spec §3.1, §7h).
 *   - org ativa SEM assinatura é isenta: pedido de cobrança → `org_isenta`;
 *   - reativar zera o último aviso da régua (passo 7);
 *   - reativar conta, no aviso da Central e no evento, o que a suspensão parou
 *     sem avisar ninguém (acabamento 22 da PR 1): o agendamento de disparo único
 *     que o scheduler desligou e o passo de follow-up falhado sem `turn_discarded`;
 *   - desligar a chave libera toda org suspensa por cobrança, pela MESMA porta
 *     de reativação, e não toca a administrativa.
 */

const P = "c0b00007-0000-4000-8000";
const ISENTA = uuid(P, 1);
const PAGANTE = uuid(P, 2);
const PAGANTE_2 = uuid(P, 3);
const ADMINISTRATIVA = uuid(P, 4);
const COM_AVISO = uuid(P, 5);
const TODAS = [ISENTA, PAGANTE, PAGANTE_2, ADMINISTRATIVA, COM_AVISO];
const DONO = uuid(P, 101);
const ADMIN = uuid(P, 102);
const PLANO = uuid(P, 901);
const CONTATO = uuid(P, 201);
const CONTATO_2 = uuid(P, 202);
const MOTIVO = "motivo de teste do invariante 0510";

const suspender = (org: string, tipo: string) =>
  resultado(`public.fn_suspender_organizacao('${org}', '${tipo}', '${MOTIVO}', '${DONO}')`);
const reativar = (org: string, tipo: string) =>
  resultado(`public.fn_reativar_organizacao('${org}', '${tipo}', '${DONO}')`);
const estado = (org: string) =>
  valor(`select status || '/' || coalesce(suspended_kind, '-') from public.organizations where id = '${org}';`);
const aviso = (org: string) =>
  valor(`select coalesce(ultimo_aviso, '-') || '|' || (ultimo_aviso_em is null)::text
           from public.cobranca_assinaturas where organization_id = '${org}';`);
const liberar = () => numero(comoServidor(`select public.fn_cobranca_liberar_suspensoes('${DONO}')`));
const lista = TODAS.map((o) => `'${o}'`).join(", ");
const corpoDoAviso = (org: string) =>
  valor(`select coalesce((select body from public.agent_inbox_items
                          where organization_id = '${org}' and kind = 'org_reativada'
                          order by created_at desc limit 1), '-');`);
const contagensDaVolta = (org: string) =>
  valor(`select coalesce(payload->>'agendamentos_desligados', '?') || '|' || coalesce(payload->>'passos_descartados', '?')
           from public.event_log where organization_id = '${org}' and event_type = 'tenant.reactivated'
          order by created_at desc limit 1;`);
/** O que o scheduler grava no disparo único vencido de org parada (lib/agent-engine/cron/scheduler.ts). */
const agendamentoDesligado = (org: string, contato: string) =>
  `insert into public.cron_jobs (organization_id, contact_id, kind, next_run_at, enabled, last_error)
     values ('${org}', '${contato}', 'at', now(), false, 'org_nao_operante');`;
/** Turno de follow-up que a C0 falhou sem `turn_discarded` (classificar resposta, planejar horário). */
const passoDescartado = (org: string, contato: string, proposito: string) =>
  `insert into public.job_queue (organization_id, contact_id, kind, payload, status, last_error)
     values ('${org}', '${contato}', 'followup_turn', '{"purpose":"${proposito}"}', 'failed', 'org_nao_operante');`;

beforeAll(() => {
  criarUsuarios([[DONO, "dono-suspensao-0510@invariant.test"], [ADMIN, "admin-suspensao-0510@invariant.test"]]);
  for (const [i, o] of TODAS.entries()) criarOrg(o, `cob-suspensao-${i + 1}`);
  vincular(ADMIN, ISENTA, "admin");
  criarPlano({ id: PLANO, nome: "Suspensão" });
  for (const o of [PAGANTE, PAGANTE_2, ADMINISTRATIVA, COM_AVISO]) assinar(o, PLANO);
  sql(`insert into public.contacts (id, organization_id, display_name) values
         ('${CONTATO}', '${PAGANTE}', 'Contato 0510'), ('${CONTATO_2}', '${PAGANTE_2}', 'Contato 0510 2')
         on conflict (id) do nothing;`);
});

beforeEach(() => {
  sql(`update public.organizations
          set status = 'active', suspended_kind = null, suspended_at = null, suspended_reason = null, suspended_by = null
        where id in (${lista});
       update public.cobranca_assinaturas set ultimo_aviso = null, ultimo_aviso_em = null where organization_id in (${lista});`);
});

describe("suspensão por cobrança e liberação", () => {
  it("⭐ org sem assinatura é isenta: o pedido de suspensão por cobrança não suspende", () => {
    const antes = eventos(ISENTA, "tenant.suspended");
    expect(suspender(ISENTA, "cobranca")).toEqual({ changed: false, motivo: "org_isenta" });
    expect(estado(ISENTA)).toBe("active/-");
    expect(eventos(ISENTA, "tenant.suspended")).toBe(antes);
  });

  it("org com assinatura é suspensa por cobrança; a administrativa não depende de assinatura", () => {
    expect(suspender(PAGANTE, "cobranca")).toEqual({ changed: true });
    expect(estado(PAGANTE)).toBe("suspended/cobranca");
    expect(suspender(ISENTA, "administrativa")).toEqual({ changed: true });
    expect(estado(ISENTA)).toBe("suspended/administrativa");
  });

  it("⭐ reativar zera o último aviso da régua (passo 7)", () => {
    sql(`update public.cobranca_assinaturas set ultimo_aviso = 'suspende_em_breve', ultimo_aviso_em = now()
          where organization_id = '${PAGANTE}';`);
    suspender(PAGANTE, "cobranca");
    expect(reativar(PAGANTE, "cobranca")).toEqual({ changed: true });
    expect(aviso(PAGANTE)).toBe("-|true");
  });

  it("reativação que não muda nada não mexe no aviso", () => {
    sql(`update public.cobranca_assinaturas set ultimo_aviso = 'venceu', ultimo_aviso_em = now() where organization_id = '${COM_AVISO}';`);
    expect(reativar(COM_AVISO, "cobranca")).toEqual({ changed: false, motivo: "nao_suspensa" });
    expect(aviso(COM_AVISO)).toBe("venceu|false");
  });

  it("reativar org isenta segue funcionando (não há linha para zerar)", () => {
    suspender(ISENTA, "administrativa");
    expect(reativar(ISENTA, "administrativa")).toEqual({ changed: true });
    expect(estado(ISENTA)).toBe("active/-");
  });

  it("⭐ a volta cita o agendamento de disparo único desligado e o passo de follow-up descartado (acabamento 22)", () => {
    suspender(PAGANTE, "cobranca");
    sql(`${agendamentoDesligado(PAGANTE, CONTATO)}
         -- recorrente só ADIADO pelo scheduler: segue vivo, não entra
         insert into public.cron_jobs (organization_id, contact_id, kind, interval_ms, next_run_at, last_error)
           values ('${PAGANTE}', '${CONTATO}', 'every', 60000, now() + interval '1 day', 'org_nao_operante');
         -- disparo único desligado ANTES desta suspensão: não é dela
         insert into public.cron_jobs (organization_id, contact_id, kind, next_run_at, enabled, last_error, updated_at)
           values ('${PAGANTE}', '${CONTATO}', 'at', now() - interval '10 days', false, 'org_nao_operante', now() - interval '10 days');
         ${passoDescartado(PAGANTE, CONTATO, "classify")}`);
    expect(reativar(PAGANTE, "cobranca")).toEqual({ changed: true });
    expect(corpoDoAviso(PAGANTE)).toBe(
      "1 agendamento de disparo único venceu durante a suspensão e não foi disparado. " +
        "1 passo de follow-up foi descartado durante a suspensão; confira o follow-up do contato.",
    );
    expect(contagensDaVolta(PAGANTE)).toBe("1|1");
  });

  it("a volta seguinte não conta de novo o que a anterior já contou", () => {
    suspender(PAGANTE_2, "cobranca");
    sql(`${agendamentoDesligado(PAGANTE_2, CONTATO_2)} ${passoDescartado(PAGANTE_2, CONTATO_2, "plan_timing")}`);
    reativar(PAGANTE_2, "cobranca");
    expect(contagensDaVolta(PAGANTE_2)).toBe("1|1");
    suspender(PAGANTE_2, "cobranca");
    expect(reativar(PAGANTE_2, "cobranca")).toEqual({ changed: true });
    expect(contagensDaVolta(PAGANTE_2)).toBe("0|0");
  });

  it("a volta conta só o disparo único de follow-up, o mesmo recorte da fila de IA › Follow-ups", () => {
    const contato = uuid(P, 203);
    sql(`insert into public.contacts (id, organization_id, display_name)
           values ('${contato}', '${ADMINISTRATIVA}', 'Contato 0510 3') on conflict (id) do nothing;`);
    suspender(ADMINISTRATIVA, "administrativa");
    sql(`${agendamentoDesligado(ADMINISTRATIVA, contato)}
         -- outro job_kind: a fila não o lista (queue/route.ts filtra followup_turn), o aviso não o conta
         insert into public.cron_jobs (organization_id, contact_id, kind, job_kind, next_run_at, enabled, last_error)
           values ('${ADMINISTRATIVA}', '${contato}', 'at', 'case_reply_turn', now(), false, 'org_nao_operante');`);
    expect(reativar(ADMINISTRATIVA, "administrativa")).toEqual({ changed: true });
    expect(contagensDaVolta(ADMINISTRATIVA)).toBe("1|0");
  });

  it("⭐ desligar a chave libera só as suspensas por cobrança, pela porta de reativação", () => {
    suspender(PAGANTE, "cobranca");
    suspender(PAGANTE_2, "cobranca");
    suspender(ADMINISTRATIVA, "administrativa");
    const antes = [PAGANTE, PAGANTE_2].map((o) => eventos(o, "tenant.reactivated"));
    expect(liberar()).toBe(2);
    expect(estado(PAGANTE)).toBe("active/-");
    expect(estado(PAGANTE_2)).toBe("active/-");
    expect(estado(ADMINISTRATIVA)).toBe("suspended/administrativa");
    expect([PAGANTE, PAGANTE_2].map((o) => eventos(o, "tenant.reactivated"))).toEqual(antes.map((n) => n + 1));
    expect(liberar()).toBe(0);
  });

  it("nenhuma sessão executa fn_cobranca_liberar_suspensoes", () => {
    const chamada = `select public.fn_cobranca_liberar_suspensoes('${DONO}')`;
    expect(erroDe(comoUsuario(ADMIN, chamada))).toContain("permission denied for function");
    expect(erroDe(comoAnon(chamada))).toContain("permission denied for function");
  });
});
