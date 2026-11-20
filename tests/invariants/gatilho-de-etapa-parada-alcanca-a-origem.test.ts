import { beforeAll, describe, expect, it } from "vitest";

import { GOV_ORG, GOV_VIEWER, lastLine, seedGov, sql } from "./gov-helpers";
import { motivoDoErro } from "./psql-transporte";

/**
 * 9206 (#4018) — `lead.stage_stale` alcança a origem do atendimento.
 *
 * O gatilho "lead parado N dias na mesma etapa" é emitido por
 * `app/api/v1/cron/lead-time-triggers` com `p_entity_kind='crm_lead'` e SEM
 * `service_origin` (correto: origem é campo do SERVIDOR). O par
 * `(lead.stage_stale, crm_lead)` não estava na tabela que as duas pontas leem,
 * `fn_service_event_contact`, e o resultado medido na issue é o mesmo da #3286:
 * o evento nasce sem carimbo E `fn_service_event_origin` o recusa com
 * `service_event_origin_unsupported` (PT409, o código da recusa permanente
 * desta casa), que `serviceForEvent`
 * engole como origem obsoleta — a ação de WhatsApp da regra termina `failed`
 * com `service_boundary_stale`, sem erro em lugar nenhum.
 *
 * A migration 0743 consertou a MESMA classe para `lead.date_field_due` e
 * deixou `lead.stage_stale` nomeado como pendente. Este arquivo prova a linha
 * nova e os quatro lados opostos que a 0743 exigiu: o par que já funcionava
 * continua, o gatilho genuinamente fora da fronteira continua recusado, o
 * evento sem contato segue sem carimbo e evento de outra organização não passa
 * a ser aceito.
 *
 * O desfecho da AÇÃO inteira (`send_whatsapp_message` enviando em vez de
 * terminar `failed`/`service_boundary_stale`) mora no harness irmão,
 * `automation-send-whatsapp.test.ts`, caso 13 — aqui se mede o par, o carimbo
 * e a resolução, que é de onde o defeito nasce.
 */

// Namespace próprio (eeeeeeee-): nenhum contato/conversa do seed é mexido.
const CONTATO = "eeeeeeee-3333-4000-8000-000000000001";
const CONVERSA = "eeeeeeee-4444-4000-8000-000000000001";
const PIPELINE = "eeeeeeee-5555-4000-8000-000000000001";
const ETAPA = "eeeeeeee-5555-4000-8000-000000000002";
/** Negócio COM contato — é o que o cron de etapa parada emite. */
const NEGOCIO = "eeeeeeee-6666-4000-8000-000000000001";
/** Negócio SEM contato — o evento dele não tem o que carimbar, hoje e depois. */
const NEGOCIO_SEM_CONTATO = "eeeeeeee-6666-4000-8000-000000000002";

// Organização VIZINHA, com negócio próprio: o par filtra por organização.
const ORG_B = "eeeeeeee-0000-4000-8000-0000000000b2";
const CONTATO_B = "eeeeeeee-3333-4000-8000-0000000000b1";
const PIPELINE_B = "eeeeeeee-5555-4000-8000-0000000000b1";
const ETAPA_B = "eeeeeeee-5555-4000-8000-0000000000b2";
const NEGOCIO_B = "eeeeeeee-6666-4000-8000-0000000000b1";

beforeAll(() => {
  seedGov();
  sql(`
    insert into public.contacts (id, organization_id, display_name)
      values ('${CONTATO}', '${GOV_ORG}', 'Etapa parada #4018')
      on conflict do nothing;
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
      select '${CONVERSA}', '${GOV_ORG}', '${CONTATO}', s.id, 'open'
        from public.channel_sessions s
       where s.organization_id = '${GOV_ORG}' and s.archived_at is null
       order by s.created_at limit 1
      on conflict do nothing;
    insert into public.crm_pipelines (id, organization_id, name, slug)
      values ('${PIPELINE}', '${GOV_ORG}', 'Funil #4018', 'funil-4018')
      on conflict do nothing;
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position)
      values ('${ETAPA}', '${GOV_ORG}', '${PIPELINE}', 'Parado há 3 dias', 'parado-4018', 1000)
      on conflict do nothing;
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, contact_id, title)
      values ('${NEGOCIO}', '${GOV_ORG}', '${PIPELINE}', '${ETAPA}', '${CONTATO}', 'Negócio #4018')
      on conflict do nothing;
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, contact_id, title)
      values ('${NEGOCIO_SEM_CONTATO}', '${GOV_ORG}', '${PIPELINE}', '${ETAPA}', null, 'Negócio sem contato #4018')
      on conflict do nothing;

    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG_B}', 'etapa-parada-4018-b', 'Org B #4018', 'Org B #4018')
      on conflict do nothing;
    insert into public.contacts (id, organization_id, display_name)
      values ('${CONTATO_B}', '${ORG_B}', 'Contato da vizinha #4018')
      on conflict do nothing;
    insert into public.crm_pipelines (id, organization_id, name, slug)
      values ('${PIPELINE_B}', '${ORG_B}', 'Funil da vizinha', 'funil-vizinha-4018')
      on conflict do nothing;
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position)
      values ('${ETAPA_B}', '${ORG_B}', '${PIPELINE_B}', 'Parado', 'parado-vizinha-4018', 1000)
      on conflict do nothing;
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, contact_id, title)
      values ('${NEGOCIO_B}', '${ORG_B}', '${PIPELINE_B}', '${ETAPA_B}', '${CONTATO_B}', 'Negócio da vizinha')
      on conflict do nothing;
  `);
});

/** `emit_event` SEM `service_origin` injetada — como o cron de etapa parada chama. */
function emitirSemOrigem(
  tipo: string,
  kind: string,
  id: string,
  org: string,
  payload: Record<string, unknown> = {},
): string {
  return lastLine(
    sql(
      `select public.emit_event('${tipo}','${kind}','${id}'::uuid,'${JSON.stringify(payload)}'::jsonb,'{}'::jsonb,'${org}'::uuid);`,
    ),
  );
}

/** O carimbo gravado, como JSON — vazio quando `emit_event` não carimbou. */
function carimboDe(eventoId: string): Record<string, unknown> {
  const bruto = lastLine(
    sql(`select coalesce(payload->'service_origin','{}'::jsonb)::text from public.event_log where id = '${eventoId}';`),
  );
  return JSON.parse(bruto) as Record<string, unknown>;
}

/** `(tipo, entidade) → contato` como o banco resolve — a MESMA tabela das duas pontas. */
function par(tipo: string, kind: string, id: string, org = GOV_ORG): { suportado: boolean; contact_id: string | null } {
  return JSON.parse(
    lastLine(
      sql(`select row_to_json(t) from (select suportado, contact_id from public.fn_service_event_contact(
         '${org}'::uuid, '${tipo}', '${kind}', '${id}'::uuid)) t;`),
    ),
  ) as { suportado: boolean; contact_id: string | null };
}

/**
 * SQLSTATE + mensagem de um comando que DEVE falhar — rodado num bloco que
 * captura a exceção. Sem o código, "deu erro" não distingue a recusa medida
 * (`40001`/`service_event_origin_unsupported`) de uma FK qualquer.
 */
function erroDe(comando: string): string {
  return lastLine(
    sql(`
      create temp table erro_4018(codigo text);
      do $erro$ begin
        begin
          ${comando}
          insert into erro_4018 values ('NENHUM');
        exception when others then
          insert into erro_4018 values (sqlstate || ':' || sqlerrm);
        end;
      end $erro$;
      select codigo from erro_4018;
    `),
  );
}

describe("9206 — lead.stage_stale alcança a origem (#4018)", () => {
  it("emitido sem origem (como o cron da varredura), o servidor carimba e a fronteira resolve a conversa", () => {
    const eventoId = emitirSemOrigem("lead.stage_stale", "crm_lead", NEGOCIO, GOV_ORG, {
      rule_id: "eeeeeeee-1111-4000-8000-000000000001",
      dias: 3,
      ancora: "2026-11-01T12:00:00Z",
      etapa_desde: "2026-11-01T12:00:00Z",
    });

    // 1) O par novo entrou na tabela única.
    expect(par("lead.stage_stale", "crm_lead", NEGOCIO), "o par novo não foi reconhecido").toEqual({
      suportado: true,
      contact_id: CONTATO,
    });

    // 2) O carimbo GRAVADO — o valor, não a existência.
    const carimbo = carimboDe(eventoId);
    expect(carimbo.kind, "o emit_event não carimbou o par novo").toBe("command");
    const observed = carimbo.observed as Record<string, unknown> | undefined;
    expect(observed?.organization_id).toBe(GOV_ORG);
    expect(observed?.contact_id).toBe(CONTATO);
    const destinos = (observed?.destinations ?? []) as Array<{ observed?: { conversation_id?: string } }>;
    expect(
      destinos.some((d) => d.observed?.conversation_id === CONVERSA),
      "o carimbo não aponta a conversa do contato",
    ).toBe(true);

    // 3) A outra ponta — a resolução — aceita o evento em vez de recusar com 40001.
    const fronteira = JSON.parse(
      lastLine(
        sql(`select public.fn_service_event_origin('${GOV_ORG}'::uuid,'${eventoId}'::uuid,'${CONTATO}'::uuid,null);`),
      ),
    ) as { conversation_id?: string };
    expect(fronteira.conversation_id).toBe(CONVERSA);
  });

  it("LADO OPOSTO (a): o gatilho que JÁ funcionava (lead.date_field_due) continua alcançando a origem", () => {
    const eventoId = emitirSemOrigem("lead.date_field_due", "crm_lead", NEGOCIO, GOV_ORG, {
      campo: "data_inicio",
      dias: 1,
    });
    expect(par("lead.date_field_due", "crm_lead", NEGOCIO).suportado).toBe(true);
    expect(carimboDe(eventoId).kind).toBe("command");
    const fronteira = JSON.parse(
      lastLine(
        sql(`select public.fn_service_event_origin('${GOV_ORG}'::uuid,'${eventoId}'::uuid,'${CONTATO}'::uuid,null);`),
      ),
    ) as { conversation_id?: string };
    expect(fronteira.conversation_id).toBe(CONVERSA);

    // E os pares de contato/agenda que a 0551/0670 abriram também seguem de pé.
    expect(par("contact.birthday", "contact", CONTATO).suportado).toBe(true);
    expect(par("contact.phone_added", "contact", CONTATO).suportado).toBe(true);
    expect(par("lead.created", "crm_lead", NEGOCIO).suportado).toBe(true);
  });

  it("LADO OPOSTO (b): gatilho genuinamente fora da fronteira continua recusado com PT409, e sem carimbo", () => {
    // `lead.silent_for` é o outro relógio do funil que a 0743 deixou de fora de
    // propósito: mesma varredura, mesma entidade, decisão própria.
    expect(par("lead.silent_for", "crm_lead", NEGOCIO).suportado).toBe(false);
    // Os quatro do encanamento do trigger de lead usam `entity_kind='lead'`.
    expect(par("lead.won", "lead", NEGOCIO).suportado).toBe(false);

    const silencioso = emitirSemOrigem("lead.silent_for", "crm_lead", NEGOCIO, GOV_ORG, { dias: 7 });
    expect(carimboDe(silencioso), "o tipo fora da lista passou a ser carimbado").toEqual({});

    const erro = erroDe(
      `perform public.fn_service_event_origin('${GOV_ORG}'::uuid,'${silencioso}'::uuid,'${CONTATO}'::uuid,null);`,
    );
    expect(erro).toBe("PT409:service_event_origin_unsupported");
  });

  it("LADO OPOSTO (c): evento cujo negócio não tem contato segue como hoje — sem carimbo", () => {
    expect(par("lead.stage_stale", "crm_lead", NEGOCIO_SEM_CONTATO)).toEqual({
      suportado: true,
      contact_id: null,
    });
    const eventoId = emitirSemOrigem("lead.stage_stale", "crm_lead", NEGOCIO_SEM_CONTATO, GOV_ORG, { dias: 3 });
    expect(carimboDe(eventoId), "evento sem contato ganhou carimbo").toEqual({});
  });

  it("LADO OPOSTO (d): evento de outra organização não passa a ser aceito", () => {
    // O evento da vizinha nasce carimbado NA ORGANIZAÇÃO DELA...
    const eventoB = emitirSemOrigem("lead.stage_stale", "crm_lead", NEGOCIO_B, ORG_B, { dias: 3 });
    expect(carimboDe(eventoB).kind).toBe("command");
    expect(par("lead.stage_stale", "crm_lead", NEGOCIO_B, ORG_B)).toEqual({
      suportado: true,
      contact_id: CONTATO_B,
    });

    // ...e a resolução da NOSSA organização não o encontra.
    const erro = erroDe(
      `perform public.fn_service_event_origin('${GOV_ORG}'::uuid,'${eventoB}'::uuid,'${CONTATO}'::uuid,null);`,
    );
    expect(erro).toBe("P0002:service_event_not_found");

    // O par também não cruza organização: o negócio da vizinha, perguntado pela
    // NOSSA organização, não resolve contato nenhum — e por isso não carimba.
    expect(par("lead.stage_stale", "crm_lead", NEGOCIO_B, GOV_ORG)).toEqual({
      suportado: true,
      contact_id: null,
    });
    const cruzado = emitirSemOrigem("lead.stage_stale", "crm_lead", NEGOCIO_B, GOV_ORG, { dias: 3 });
    expect(carimboDe(cruzado), "carimbou contato de outra organização").toEqual({});
  });
});

/**
 * O gatilho também entra na lista de eventos reservados ao servidor, ao lado de
 * `lead.date_field_due`: quem o emite é só a varredura (sem sessão), e a partir
 * daqui ele alcança a origem e manda WhatsApp de verdade — forjado por um
 * login, seria envio em nome de uma etapa que ninguém parou.
 */
describe("9206 — lead.stage_stale é do servidor (#4018)", () => {
  it("um viewer NÃO emite lead.stage_stale — 42501 reserved_message_received", () => {
    let erro: string | null = null;
    try {
      sql(`
        begin;
        set local role authenticated;
        select set_config('request.jwt.claims', '{"sub":"${GOV_VIEWER}"}', true) is not null;
        select public.emit_event('lead.stage_stale', 'crm_lead', '${NEGOCIO}'::uuid,
          '{}'::jsonb, '{}'::jsonb, '${GOV_ORG}'::uuid);
        rollback;`);
    } catch (err) {
      erro = motivoDoErro(err);
    }
    expect(erro, "um viewer emitiu lead.stage_stale SEM erro").not.toBeNull();
    expect(erro).toContain("reserved_message_received");
  });

  it("CONTROLE: o MESMO viewer emite um tipo não reservado", () => {
    // Sem isto, um 42501 de outra origem (membership, suporte somente leitura)
    // leria como "a reserva funcionou".
    const saida = sql(`
      begin;
      set local role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${GOV_VIEWER}"}', true) is not null;
      select 'EMITIU:' || public.emit_event('lead.stage_changed', 'crm_lead', '${NEGOCIO}'::uuid,
        '{}'::jsonb, '{}'::jsonb, '${GOV_ORG}'::uuid);
      rollback;`);
    expect(saida).toContain("EMITIU:");
  });
});
