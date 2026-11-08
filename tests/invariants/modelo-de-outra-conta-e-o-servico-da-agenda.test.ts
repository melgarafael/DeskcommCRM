/**
 * A LIMPEZA DOS MODELOS DE OUTRA CONTA E O GUARDA DO SERVIÇO DA AGENDA.
 *
 * Apagar um modelo faz a FK zerar `calendar_event_types.reminder_meta_template_id`,
 * e esse UPDATE passa por `trg_calendar_service_type_guard`. O guarda recusa
 * qualquer UPDATE de serviço ativo sem agenda ou sem profissional válido, e a
 * revogação de um membro não mexe no serviço: um único tipo nesse estado derruba
 * o DELETE inteiro. `lib/channels/modelos-de-outra-conta.ts` depende desta
 * medida: é por ela que a falha vai para a Central, e não só para o log.
 *
 * Se o guarda deixar de olhar para esse UPDATE, o primeiro caso fica vermelho,
 * e a frase sobre a Agenda no aviso `AVISO_MODELOS_FICARAM` deixa de ser verdade.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

// Namespace próprio (93908000-).
const ORG = "93908000-0000-4000-8000-000000000001";
const ADMIN = "93908000-1111-4000-8000-000000000001";
const SESSAO = "93908000-2222-4000-8000-000000000001";
const MODELO = "93908000-3333-4000-8000-000000000001";
const TIPO = "93908000-4444-4000-8000-000000000001";

function valor(consulta: string): string {
  return (sql(consulta).trim().split("\n").at(-1) ?? "").trim();
}

function erroDe(script: string): string {
  try {
    sql(script);
    return "";
  } catch (e) {
    return motivoDoErro(e);
  }
}

const LIMPEZA = `delete from public.meta_templates
  where organization_id = '${ORG}' and channel_session_id = '${SESSAO}' and waba_id <> 'conta-nova';`;

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values ('${ADMIN}', 'modelo-3908@invariant.test') on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'modelo-3908', 'Modelo 3908', 'Modelo 3908') on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${ADMIN}', '${ORG}', 'admin', now()) on conflict do nothing;
    do $seed$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${SESSAO}', '${ORG}', 'modelo-3908', '\\x00'::bytea);
    exception when unique_violation then null; end $seed$;
    insert into public.meta_templates (id, organization_id, waba_id, name, language, status, components, contract_hash, channel_session_id)
      values ('${MODELO}', '${ORG}', 'conta-velha', 'lembrete_3908', 'pt_BR', 'APPROVED', '[]'::jsonb, '', '${SESSAO}')
      on conflict do nothing;
    insert into public.calendar_event_types (id, organization_id, name, slug, duration_minutes, minimum_notice_minutes, service_enabled, booking_mode, reminder_meta_template_id)
      values ('${TIPO}', '${ORG}', 'Consulta 3908', 'consulta-3908', 40, 0, true, 'individual', '${MODELO}')
      on conflict do nothing;
    insert into public.calendar_service_schedule (organization_id, event_type_id, weekday, timing_kind, start_minute)
      values ('${ORG}', '${TIPO}', 2, 'fixed', 840);
    insert into public.calendar_service_professionals values ('${ORG}', '${TIPO}', '${ADMIN}') on conflict do nothing;
  `);
});

describe("limpeza dos modelos de outra conta sob um serviço ativo da Agenda", () => {
  it("serviço cujo profissional foi revogado: o DELETE inteiro é recusado e o modelo fica", () => {
    sql(`update public.user_organizations set revoked_at = now()
      where organization_id = '${ORG}' and user_id = '${ADMIN}';`);

    expect(erroDe(LIMPEZA)).toContain("service_configuration_invalid");
    expect(valor(`select count(*) from public.meta_templates where id = '${MODELO}'`)).toBe("1");
    expect(
      valor(`select reminder_meta_template_id from public.calendar_event_types where id = '${TIPO}'`),
    ).toBe(MODELO);
  });

  it("CONTROLE: com o serviço válido, o mesmo DELETE passa e o lembrete fica sem modelo", () => {
    sql(`update public.user_organizations set revoked_at = null
      where organization_id = '${ORG}' and user_id = '${ADMIN}';`);

    sql(LIMPEZA);
    expect(valor(`select count(*) from public.meta_templates where id = '${MODELO}'`)).toBe("0");
    expect(
      valor(`select coalesce(reminder_meta_template_id::text, 'nulo') from public.calendar_event_types where id = '${TIPO}'`),
    ).toBe("nulo");
  });
});
