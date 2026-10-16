import { beforeAll, describe, expect, it } from "vitest";

import { GOV_ORG, GOV_SESSION, GOV_VIEWER, lastLine, seedGov, sql } from "./gov-helpers";
import { motivoDoErro } from "./psql-transporte";

/**
 * 0670 (#2812) — `contact.phone_added` alcança a origem do atendimento.
 *
 * O PATCH de contatos emite o evento pelo admin client, sem `service_origin`.
 * Sem o tipo em `fn_service_event_contact`, o `emit_event` não carimbava a
 * origem e `fn_service_event_origin` o recusava com
 * `service_event_origin_unsupported` (`PT409`): a regra "ganhou telefone →
 * enviar WhatsApp" terminava `failed` com `service_boundary_stale` — o mesmo
 * defeito da #2326 (0551). E, como o aniversário, o tipo é do servidor: um
 * viewer não o emite.
 */

// Contato e conversa próprios: os do seed são mexidos por outros arquivos.
const CONTATO = "cccccccc-3333-4000-8000-000000002812";
const CONVERSA = "cccccccc-4444-4000-8000-000000002812";

beforeAll(() => {
  seedGov();
  sql(`
    insert into public.contacts (id, organization_id, display_name, phone_number)
      values ('${CONTATO}', '${GOV_ORG}', 'Telefone ganho #2812', '+5511999992812')
      on conflict do nothing;
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
      values ('${CONVERSA}', '${GOV_ORG}', '${CONTATO}', '${GOV_SESSION}', 'open')
      on conflict do nothing;
  `);
});

describe("0670 — contact.phone_added alcança a origem (#2812)", () => {
  it("emitido sem origem (como o PATCH de contatos), o servidor carimba e a fronteira resolve a conversa", () => {
    const eventoId = lastLine(
      sql(`select public.emit_event('contact.phone_added', 'contact', '${CONTATO}'::uuid,
        '{"phone_number":"+5511999992812"}'::jsonb, '{}'::jsonb, '${GOV_ORG}'::uuid);`),
    );
    expect(
      lastLine(sql(`select (payload ? 'service_origin')::text from public.event_log where id = '${eventoId}';`)),
      "o emit_event não carimbou service_origin",
    ).toBe("true");

    // Sem o conserto: service_event_origin_unsupported (PT409).
    const fronteira = JSON.parse(
      lastLine(
        sql(`select public.fn_service_event_origin('${GOV_ORG}'::uuid, '${eventoId}'::uuid,
          '${CONTATO}'::uuid, '${GOV_SESSION}'::uuid);`),
      ),
    ) as { conversation_id?: string };
    expect(fronteira.conversation_id).toBe(CONVERSA);
  });

  it("um viewer NÃO emite contact.phone_added — 42501", () => {
    let erro: string | null = null;
    try {
      sql(`
        begin;
        set local role authenticated;
        select set_config('request.jwt.claims', '{"sub":"${GOV_VIEWER}"}', true) is not null;
        select public.emit_event('contact.phone_added', 'contact', '${CONTATO}'::uuid,
          '{}'::jsonb, '{}'::jsonb, '${GOV_ORG}'::uuid);
        rollback;`);
    } catch (err) {
      erro = motivoDoErro(err);
    }
    expect(erro, "um viewer emitiu contact.phone_added SEM erro").not.toBeNull();
    expect(erro).toContain("reserved_message_received");
  });

  it("CONTROLE: o MESMO viewer emite um tipo não reservado", () => {
    // Sem isto, um 42501 de outra origem (membership, suporte somente leitura)
    // leria como "a reserva funcionou".
    const saida = sql(`
      begin;
      set local role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${GOV_VIEWER}"}', true) is not null;
      select 'EMITIU:' || public.emit_event('contact.tag_added', 'contact', '${CONTATO}'::uuid,
        '{}'::jsonb, '{}'::jsonb, '${GOV_ORG}'::uuid);
      rollback;`);
    expect(saida).toContain("EMITIU:");
  });
});
