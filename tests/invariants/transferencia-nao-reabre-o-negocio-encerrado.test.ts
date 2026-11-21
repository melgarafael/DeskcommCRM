import { beforeAll, describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

/**
 * #4852 — TROCAR DE FUNIL NÃO REABRE NEGÓCIO ENCERRADO.
 *
 * O pedido do mantenedor, medido contra Postgres real (é o mesmo invariante que
 * ele rodou no PR, com o `baseline.sql` aplicado em install e em update):
 *
 *   `[M1] antes=won|2026-11-18 10:55:11+00 depois=open|null|<funil de destino>`
 *
 * A transferência em massa só aceita etapa de ANDAMENTO, e
 * `fn_crm_lead_close_on_stage` reabria todo ganho/perdido que entrava numa etapa
 * aberta. Resultado: arquivar um funil fazia as vendas fechadas deixarem de
 * contar como fechadas — e sem a data de fechamento, porque a CHECK
 * `crm_leads_closed_at_consistency` não deixa `status='won'` com `closed_at` nulo.
 *
 * O conserto é a guarda de `pipeline_id` no gatilho (migration 9412 §3): mudar de
 * funil NÃO é reabrir. Este arquivo mede os DOIS lados:
 *
 *   1. a transferência entre funis preserva `status`, `closed_at` e o motivo;
 *   2. a reabertura de sempre (mesmo funil, etapa aberta) continua acontecendo —
 *      sem esta metade, "não reabre nunca" passaria no teste e quebraria o arrasto.
 *
 * Roda pela suíte de banco (`pnpm test:db`), com o banco próprio por arquivo do
 * harness: um teste de unidade não alcança gatilho de banco, e é o gatilho que
 * escreve `status` (P-02).
 *
 * Namespace 9f41.
 */

const ORG = "9f410001-0000-4000-8000-000000000000";
const PIPE_ORIGEM = "9f410002-0000-4000-8000-000000000001";
const PIPE_DESTINO = "9f410002-0000-4000-8000-000000000002";
const ETAPA_ABERTA_ORIGEM = "9f410003-0000-4000-8000-000000000001";
const ETAPA_GANHO_ORIGEM = "9f410003-0000-4000-8000-000000000002";
const ETAPA_PERDA_ORIGEM = "9f410003-0000-4000-8000-000000000003";
const ETAPA_ABERTA_DESTINO = "9f410003-0000-4000-8000-000000000004";

const LEAD_GANHO = "9f410004-0000-4000-8000-000000000001";
const LEAD_PERDIDO = "9f410004-0000-4000-8000-000000000002";
const LEAD_ABERTO = "9f410004-0000-4000-8000-000000000003";
const LEAD_GANHO_QUE_FICA = "9f410004-0000-4000-8000-000000000004";
const LEAD_GANHO_QUE_REABRE = "9f410004-0000-4000-8000-000000000005";

const FECHADO_EM = "2026-11-18 10:55:11+00";

/** `status|closed_at|pipeline_id|stage_id|lost_reason` de um negócio. */
function retrato(leadId: string): string {
  const out = sql(`
    select coalesce(status, '<null>')
           || '|' || coalesce(to_char(closed_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), '<null>')
           || '|' || pipeline_id::text
           || '|' || stage_id::text
           || '|' || coalesce(lost_reason, '<null>')
      from public.crm_leads where id = '${leadId}';
  `);
  return lastLine(out);
}

beforeAll(() => {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'inv-9f41', 'Inv 9f41', 'Inv 9f41')
      on conflict (id) do nothing;

    insert into public.crm_pipelines (id, organization_id, name, slug, position) values
      ('${PIPE_ORIGEM}', '${ORG}', 'Origem', 'origem-9f41', 1000),
      ('${PIPE_DESTINO}', '${ORG}', 'Destino', 'destino-9f41', 2000)
      on conflict (id) do nothing;

    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position, is_won, is_lost) values
      ('${ETAPA_ABERTA_ORIGEM}', '${ORG}', '${PIPE_ORIGEM}', 'Novo', 'novo', 1000, false, false),
      ('${ETAPA_GANHO_ORIGEM}', '${ORG}', '${PIPE_ORIGEM}', 'Ganho', 'ganho', 2000, true, false),
      ('${ETAPA_PERDA_ORIGEM}', '${ORG}', '${PIPE_ORIGEM}', 'Perdido', 'perdido', 3000, false, true),
      ('${ETAPA_ABERTA_DESTINO}', '${ORG}', '${PIPE_DESTINO}', 'Novo destino', 'novo-destino', 1000, false, false)
      on conflict (id) do nothing;

    -- Os dois encerrados, com a data de fechamento controlada (o gatilho de
    -- INSERT respeita o closed_at que veio: ele usa coalesce).
    insert into public.crm_leads
      (id, organization_id, pipeline_id, stage_id, title, status, closed_at, won_reason, lost_reason)
    values
      ('${LEAD_GANHO}', '${ORG}', '${PIPE_ORIGEM}', '${ETAPA_GANHO_ORIGEM}', 'Venda fechada',
       'won', '${FECHADO_EM}', 'Indicação', null),
      ('${LEAD_PERDIDO}', '${ORG}', '${PIPE_ORIGEM}', '${ETAPA_PERDA_ORIGEM}', 'Perdida',
       'lost', '${FECHADO_EM}', null, 'price'),
      ('${LEAD_ABERTO}', '${ORG}', '${PIPE_ORIGEM}', '${ETAPA_ABERTA_ORIGEM}', 'Em andamento',
       'open', null, null, null),
      -- Estes dois ficam para o segundo caso (reabertura de sempre).
      ('${LEAD_GANHO_QUE_FICA}', '${ORG}', '${PIPE_ORIGEM}', '${ETAPA_GANHO_ORIGEM}', 'Fica',
       'won', '${FECHADO_EM}', 'Indicação', null),
      ('${LEAD_GANHO_QUE_REABRE}', '${ORG}', '${PIPE_ORIGEM}', '${ETAPA_GANHO_ORIGEM}', 'Reabre',
       'won', '${FECHADO_EM}', 'Indicação', null)
      on conflict (id) do nothing;
  `);
});

describe("fn_mover_leads_em_lote entre funis (#4852)", () => {
  it("(a) o GANHO continua ganho, com a MESMA data de fechamento, no funil de destino", () => {
    const antes = retrato(LEAD_GANHO);
    expect(antes).toBe(`won|2026-11-18 10:55:11|${PIPE_ORIGEM}|${ETAPA_GANHO_ORIGEM}|<null>`);

    sql(`
      select * from public.fn_mover_leads_em_lote(
        '${ORG}'::uuid,
        array['${LEAD_GANHO}'::uuid],
        '${ETAPA_ABERTA_DESTINO}'::uuid,
        null
      );
    `);

    // O M1 do mantenedor, depois do conserto: `won`, a data de antes e o funil novo.
    expect(retrato(LEAD_GANHO)).toBe(
      `won|2026-11-18 10:55:11|${PIPE_DESTINO}|${ETAPA_ABERTA_DESTINO}|<null>`,
    );
  });

  it("(a2) o PERDIDO continua perdido, com o motivo da perda intacto", () => {
    sql(`
      select * from public.fn_mover_leads_em_lote(
        '${ORG}'::uuid,
        array['${LEAD_PERDIDO}'::uuid],
        '${ETAPA_ABERTA_DESTINO}'::uuid,
        null
      );
    `);

    expect(retrato(LEAD_PERDIDO)).toBe(
      `lost|2026-11-18 10:55:11|${PIPE_DESTINO}|${ETAPA_ABERTA_DESTINO}|price`,
    );
  });

  it("(a3) o ABERTO continua aberto e sem data de fechamento", () => {
    sql(`
      select * from public.fn_mover_leads_em_lote(
        '${ORG}'::uuid,
        array['${LEAD_ABERTO}'::uuid],
        '${ETAPA_ABERTA_DESTINO}'::uuid,
        null
      );
    `);

    expect(retrato(LEAD_ABERTO)).toBe(
      `open|<null>|${PIPE_DESTINO}|${ETAPA_ABERTA_DESTINO}|<null>`,
    );
  });

  it("(b) o lote inteiro de uma vez: cada um mantém o próprio desfecho", () => {
    const ganho = "9f410004-0000-4000-8000-000000000006";
    const perdido = "9f410004-0000-4000-8000-000000000007";
    sql(`
      insert into public.crm_leads
        (id, organization_id, pipeline_id, stage_id, title, status, closed_at, won_reason, lost_reason)
      values
        ('${ganho}', '${ORG}', '${PIPE_ORIGEM}', '${ETAPA_GANHO_ORIGEM}', 'Lote ganho', 'won', '${FECHADO_EM}', 'Indicação', null),
        ('${perdido}', '${ORG}', '${PIPE_ORIGEM}', '${ETAPA_PERDA_ORIGEM}', 'Lote perdido', 'lost', '${FECHADO_EM}', null, 'other')
        on conflict (id) do nothing;

      select * from public.fn_mover_leads_em_lote(
        '${ORG}'::uuid,
        array['${ganho}'::uuid, '${perdido}'::uuid],
        '${ETAPA_ABERTA_DESTINO}'::uuid,
        null
      );
    `);

    expect(retrato(ganho)).toBe(
      `won|2026-11-18 10:55:11|${PIPE_DESTINO}|${ETAPA_ABERTA_DESTINO}|<null>`,
    );
    expect(retrato(perdido)).toBe(
      `lost|2026-11-18 10:55:11|${PIPE_DESTINO}|${ETAPA_ABERTA_DESTINO}|other`,
    );
  });

  it("(c) a REABERTURA DE SEMPRE continua: mesmo funil, etapa aberta reabre", () => {
    // A outra metade da guarda. Se o conserto tivesse virado "não reabre nunca",
    // o arrasto do quadro pararia de reabrir — e o funil ficaria com negócio
    // encerrado em etapa de andamento para sempre.
    expect(retrato(LEAD_GANHO_QUE_REABRE)).toBe(
      `won|2026-11-18 10:55:11|${PIPE_ORIGEM}|${ETAPA_GANHO_ORIGEM}|<null>`,
    );

    sql(`
      select * from public.fn_mover_leads_em_lote(
        '${ORG}'::uuid,
        array['${LEAD_GANHO_QUE_REABRE}'::uuid],
        '${ETAPA_ABERTA_ORIGEM}'::uuid,
        null
      );
    `);

    expect(retrato(LEAD_GANHO_QUE_REABRE)).toBe(
      `open|<null>|${PIPE_ORIGEM}|${ETAPA_ABERTA_ORIGEM}|<null>`,
    );
  });

  it("(d) o negócio que NÃO mudou de funil nem de etapa segue encerrado", () => {
    // Um lote não pode reescrever o desfecho de quem ficou fora dele.
    expect(retrato(LEAD_GANHO_QUE_FICA)).toBe(
      `won|2026-11-18 10:55:11|${PIPE_ORIGEM}|${ETAPA_GANHO_ORIGEM}|<null>`,
    );
  });
});
