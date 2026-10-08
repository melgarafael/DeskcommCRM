import { beforeAll, describe, expect, it } from "vitest";

import { GOV_LEAD, GOV_MANAGER, GOV_ORG, GOV_VIEWER, seedGov, sql } from "./gov-helpers";
import { motivoDoErro } from "./psql-transporte";

/**
 * Os eventos de desfecho e de responsável do negócio nascem do próprio negócio.
 *
 * `lead.won`, `lead.lost`, `lead.reopened` e `lead.assigned` têm UMA fonte: o
 * gatilho `fn_emit_event_on_lead_change`, quando `crm_leads.status` ou o
 * responsável muda de fato. Os consumidores produzem efeito real (push,
 * webhooks de saída, conversão para anúncios). `emit_event` e `fn_log_event`
 * têm grant para `authenticated`, então a reserva tem de valer para a sessão —
 * e, ao mesmo tempo, o gatilho roda DENTRO da sessão de quem moveu o card
 * (`auth.uid()` segue preenchido), então a reserva não pode calá-lo.
 */

const RESERVADOS = ["lead.won", "lead.lost", "lead.reopened", "lead.assigned"] as const;

function comoSessao(usuario: string, corpo: string): string {
  return `
    begin;
    set local role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${usuario}"}', true) is not null;
    ${corpo}
    rollback;`;
}

function emitePorEmitEvent(tipo: string): string {
  return `select 'EMITIU:' || public.emit_event('${tipo}', 'crm_lead', '${GOV_LEAD}'::uuid,
    '{}'::jsonb, '{}'::jsonb, '${GOV_ORG}'::uuid);`;
}

function erroDe(script: string): string | null {
  try {
    sql(script);
    return null;
  } catch (err) {
    return motivoDoErro(err);
  }
}

beforeAll(() => {
  seedGov();
});

describe("eventos de desfecho do negócio são do gatilho do negócio", () => {
  it.each(RESERVADOS)("um membro NÃO emite %s por emit_event — 42501", (tipo) => {
    const erro = erroDe(comoSessao(GOV_VIEWER, emitePorEmitEvent(tipo)));
    expect(erro, `um viewer emitiu ${tipo} SEM erro`).not.toBeNull();
    // Nome herdado da reserva original (0279): renomear é mudança de contrato.
    expect(erro).toContain("reserved_message_received");
  });

  it("nem pelo fn_log_event, que delega a emit_event", () => {
    const erro = erroDe(
      comoSessao(
        GOV_VIEWER,
        `select 'EMITIU:' || public.fn_log_event('${GOV_ORG}'::uuid, 'lead.won',
          jsonb_build_object('lead_id', '${GOV_LEAD}'));`,
      ),
    );
    expect(erro, "fn_log_event emitiu lead.won SEM erro").not.toBeNull();
    expect(erro).toContain("reserved_message_received");
  });

  it("CONTROLE: o MESMO viewer emite lead.stage_changed, que a rota de mover emite pela sessão", () => {
    // Sem isto, um 42501 vindo de outro lugar (membership, suporte somente
    // leitura) leria exatamente como "a reserva funcionou".
    expect(sql(comoSessao(GOV_VIEWER, emitePorEmitEvent("lead.stage_changed")))).toContain("EMITIU:");
  });

  it("ganhar o negócio pela sessão segue emitindo lead.won — e a janela fecha em seguida", () => {
    const saida = sql(
      comoSessao(
        GOV_MANAGER,
        `update public.crm_leads set status = 'won', closed_at = now() where id = '${GOV_LEAD}';
         reset role;
         select 'GANHOS:' || count(*) from public.event_log
          where organization_id = '${GOV_ORG}' and event_type = 'lead.won' and entity_id = '${GOV_LEAD}';
         set local role authenticated;
         do $$ begin
           perform public.emit_event('lead.won', 'crm_lead', '${GOV_LEAD}'::uuid,
             '{}'::jsonb, '{}'::jsonb, '${GOV_ORG}'::uuid);
           perform set_config('teste.janela', 'aberta', true);
         exception when insufficient_privilege then
           perform set_config('teste.janela', 'fechada', true);
         end $$;
         select 'JANELA:' || current_setting('teste.janela');`,
      ),
    );
    expect(saida).toContain("GANHOS:1");
    expect(saida).toContain("JANELA:fechada");
  });

  it("o servidor (sem sessão) segue emitindo lead.won", () => {
    const saida = sql(`
      begin;
      ${emitePorEmitEvent("lead.won")}
      rollback;`);
    expect(saida).toContain("EMITIU:");
  });
});
