import { beforeAll, describe, expect, it } from "vitest";

import { GOV_CONTACT_1, GOV_ORG, GOV_VIEWER, seedGov, sql } from "./gov-helpers";
import { motivoDoErro } from "./psql-transporte";

/**
 * 0551 (#2330) — `contact.birthday` é do servidor.
 *
 * Desde a 0551 o aniversário alcança a origem do atendimento e a ação de
 * WhatsApp envia de verdade. Quem o emite é só o cron `contact-birthdays`, pelo
 * admin client (sem `auth.uid()`). `emit_event` tem grant para `authenticated`:
 * sem a reserva, qualquer viewer dispararia o envio para qualquer contato da
 * organização com `emit_event('contact.birthday', ...)`.
 */

function comoViewer(tipo: string): string {
  return `
    begin;
    set local role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${GOV_VIEWER}"}', true) is not null;
    select 'EMITIU:' || public.emit_event('${tipo}', 'contact', '${GOV_CONTACT_1}'::uuid,
      '{}'::jsonb, '{}'::jsonb, '${GOV_ORG}'::uuid);
    rollback;`;
}

beforeAll(() => {
  seedGov();
});

describe("0551 — emit_event reserva contact.birthday ao servidor", () => {
  it("um viewer NÃO emite contact.birthday — 42501", () => {
    let erro: string | null = null;
    try {
      sql(comoViewer("contact.birthday"));
    } catch (err) {
      erro = motivoDoErro(err);
    }
    expect(erro, "um viewer emitiu contact.birthday SEM erro").not.toBeNull();
    // Nome herdado da reserva original (0279): renomear é mudança de contrato.
    expect(erro).toContain("reserved_message_received");
  });

  it("CONTROLE: o MESMO viewer emite um tipo não reservado", () => {
    // Sem isto, um 42501 vindo de outro lugar (membership, suporte somente
    // leitura) leria exatamente como "a reserva funcionou".
    expect(sql(comoViewer("contact.tag_added"))).toContain("EMITIU:");
  });

  it("o cron (sem sessão) segue emitindo contact.birthday", () => {
    const saida = sql(`
      begin;
      select 'EMITIU:' || public.emit_event('contact.birthday', 'contact', '${GOV_CONTACT_1}'::uuid,
        '{"local_date":"2026-07-17"}'::jsonb, '{"actor_kind":"system"}'::jsonb, '${GOV_ORG}'::uuid);
      rollback;`);
    expect(saida).toContain("EMITIU:");
  });
});
