import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * 0071 — o barramento da vida do lead, contra Postgres real.
 *
 * Prova as três coisas que só o banco pode garantir:
 * 1. **Lastro**: atividade de IA sem `run_ids`/`trace_ids` é recusada — e um
 *    array VAZIO também, que é o furo de `evidence ? 'run_ids'`.
 * 2. **Backfill não apaga**: `actor_kind`/`reason` que já viviam em `metadata`
 *    sobem para as colunas; linha marcada `'ai'` sem lastro degrada para
 *    `'system'` em vez de derrubar a criação da constraint num clone.
 * 3. **stage_changed_at** carimba na entrada do estágio e SÓ nela.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}
const containerName: string = container;

function psql(script: string, stopOnError = true): string {
  return execFileSync(
    "docker",
    [
      "exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres",
      ...(stopOnError ? ["-v", "ON_ERROR_STOP=1"] : []),
      "-tA", "-f", "-",
    ],
    { input: script, encoding: "utf8" },
  ).trim();
}

/** Roda SQL que DEVE falhar; devolve o nome da constraint violada. */
function constraintViolada(script: string): string {
  try {
    execFileSync(
      "docker",
      ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
      { input: script, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    );
  } catch (err) {
    const stderr = String((err as { stderr?: Buffer }).stderr ?? "");
    return /violates check constraint "([^"]+)"/.exec(stderr)?.[1] ?? stderr.slice(0, 200);
  }
  return "(nenhum erro — o banco ACEITOU o estado incoerente)";
}

const ORG = "0071aaaa-0000-4000-8000-000000000001";
const PIPELINE = "0071aaaa-3333-4000-8000-000000000001";
const STAGE_A = "0071aaaa-4444-4000-8000-00000000000a";
const STAGE_B = "0071aaaa-4444-4000-8000-00000000000b";
const LEAD = "0071aaaa-5555-4000-8000-000000000001";
const AGENT = "0071aaaa-2222-4000-8000-000000000001";
const ATIV_LEGADA = "0071aaaa-6666-4000-8000-000000000001";
const ATIV_IA_SEM_LASTRO = "0071aaaa-6666-4000-8000-000000000002";

beforeAll(() => {
  psql(`
    insert into organizations (id, slug, legal_name, display_name)
    values ('${ORG}', 'org-0071', 'Org 0071', 'Org 0071') on conflict (id) do nothing;

    insert into ai_agents (id, organization_id, name, system_prompt)
    values ('${AGENT}', '${ORG}', 'Bot 0071', 'prompt') on conflict (id) do nothing;

    insert into crm_pipelines (id, organization_id, name, slug)
    values ('${PIPELINE}', '${ORG}', 'Pipeline 0071', 'pipeline-0071') on conflict (id) do nothing;

    insert into crm_stages (id, organization_id, pipeline_id, name, slug, position) values
      ('${STAGE_A}', '${ORG}', '${PIPELINE}', 'Etapa A', 'etapa-a', 1000),
      ('${STAGE_B}', '${ORG}', '${PIPELINE}', 'Etapa B', 'etapa-b', 2000)
    on conflict (id) do nothing;

    insert into crm_leads (id, organization_id, pipeline_id, stage_id, title)
    values ('${LEAD}', '${ORG}', '${PIPELINE}', '${STAGE_A}', 'Lead 0071')
    on conflict (id) do nothing;

    -- Linhas "legadas": como o banco ficava ANTES da 0071 — o que se sabia do
    -- ator morava só dentro de metadata (lib/ai/handoff/orchestrator.ts).
    insert into crm_lead_activities
      (id, organization_id, lead_id, type, source_module, actor_kind, reason, evidence, metadata)
    values
      ('${ATIV_LEGADA}', '${ORG}', '${LEAD}', 'handoff_triggered', 'ai', null, null, null,
       '{"actor_kind":"system","reason":"palavra-chave de handoff","run_ids":["11111111-1111-4111-8111-111111111111"]}'::jsonb),
      ('${ATIV_IA_SEM_LASTRO}', '${ORG}', '${LEAD}', 'note_added', 'ai', null, null, null,
       '{"actor_kind":"ai","reason":"achismo sem execução registrada"}'::jsonb)
    on conflict (id) do update set actor_kind = null, reason = null, evidence = null;
  `);

  // Re-aplica a migration (ela é idempotente) — é o que um clone faz ao
  // atualizar. É aqui que o backfill roda sobre as linhas legadas acima.
  psql(readFileSync("supabase/migrations/20260725010000_0071_crm_lead_activities_barramento.sql", "utf8"));
  // A 0072 vem JUNTO, e não é detalhe: reaplicar só a 0071 DESFAZ a 0072 para
  // todo mundo que rodar depois — ela redefine
  // `crm_lead_activities_ai_needs_evidence` sem `llm_call_ids`, e o banco fica
  // numa versão que o repositório já não tem.
  //
  // Este arquivo prova o backfill da 0071, então precisa mesmo reaplicá-la; o
  // que não pode é deixar o banco num estado do passado. Migration reaplicada
  // isoladamente é uma viagem no tempo que não volta sozinha — e o teste
  // seguinte mede o passado sem saber.
  psql(readFileSync("supabase/migrations/20260725020000_0072_activity_evidence_llm_call_ids.sql", "utf8"));
  // A 0071 também recria fn_lgpd_cascade_redact_contact — com cpf_encrypted/
  // cpf_hash, os nomes corretos NA ÉPOCA. A 0166 (CPF/CNPJ→NUIT) renomeou as
  // colunas via ALTER TABLE, que não segue para dentro de corpo de função
  // plpgsql (texto opaco); a 0169 é o forward-fix que devolve a função ao
  // nome de coluna que existe. Sem reaplicá-la aqui, este arquivo deixa a
  // anonimização quebrada para o describe() de LGPD logo abaixo — mesma
  // viagem no tempo que o comentário acima já resolve para a 0072.
  psql(readFileSync("supabase/migrations/20260902120000_0169_redact_contact_usa_nuit.sql", "utf8"));
});

describe("0071 — o backfill não apaga o que já se sabia", () => {
  it("actor_kind e reason sobem de metadata para as colunas", () => {
    expect(
      psql(`select actor_kind || '|' || reason from crm_lead_activities where id='${ATIV_LEGADA}';`),
    ).toBe("system|palavra-chave de handoff");
  });

  it("o lastro que existia em metadata vira evidence (não é inventado)", () => {
    expect(
      psql(`select jsonb_array_length(evidence->'run_ids') from crm_lead_activities where id='${ATIV_LEGADA}';`),
    ).toBe("1");
  });

  it("linha marcada 'ai' SEM lastro degrada para 'system' e mantém o reason", () => {
    // Recusa a AUTORIA sem prova, preserva o registro — e é o que impede o
    // update.sh de um clone de quebrar ao criar a constraint.
    expect(
      psql(`select actor_kind || '|' || reason from crm_lead_activities where id='${ATIV_IA_SEM_LASTRO}';`),
    ).toBe("system|achismo sem execução registrada");
  });
});

describe("0071 — o banco exige lastro de quem afirma ser a IA", () => {
  const insere = (kind: string, evidence: string) => `
    insert into crm_lead_activities (organization_id, lead_id, type, source_module, actor_kind, evidence)
    values ('${ORG}', '${LEAD}', 'teste', 'ai', '${kind}', ${evidence});`;

  it("ai sem evidence nenhuma é rejeitado", () => {
    expect(constraintViolada(insere("ai", "null"))).toBe("crm_lead_activities_ai_needs_evidence");
  });

  it("ai com run_ids VAZIO é rejeitado (o furo do `evidence ? 'run_ids'`)", () => {
    expect(constraintViolada(insere("ai", `'{"run_ids":[]}'::jsonb`))).toBe(
      "crm_lead_activities_ai_needs_evidence",
    );
  });

  it("ai com run_ids preenchido passa", () => {
    psql(insere("ai", `'{"run_ids":["22222222-2222-4222-8222-222222222222"]}'::jsonb`));
    expect(
      psql(`select count(*) from crm_lead_activities where actor_kind='ai' and lead_id='${LEAD}';`),
    ).toBe("1");
  });

  it("ai com trace_ids também passa — qualquer um dos dois sustenta", () => {
    psql(insere("ai", `'{"trace_ids":["33333333-3333-4333-8333-333333333333"]}'::jsonb`));
    expect(
      psql(`select count(*) from crm_lead_activities where actor_kind='ai' and lead_id='${LEAD}';`),
    ).toBe("2");
  });

  it("system, rule, user e contact não precisam de lastro", () => {
    for (const kind of ["system", "rule", "user", "contact"]) {
      psql(insere(kind, "null"));
    }
    expect(
      psql(`select count(*) from crm_lead_activities where actor_kind in ('system','rule','user','contact') and lead_id='${LEAD}';`),
    ).toBe("6"); // 4 novas + as 2 legadas degradadas/backfilladas
  });

  it("'lead' não é ator: o negócio não fala, a pessoa fala ('contact')", () => {
    expect(constraintViolada(insere("lead", "null"))).toBe("crm_lead_activities_actor_kind_check");
  });
});

describe("0071 — stage_changed_at carimba a entrada no estágio, e só ela", () => {
  it("mudar de estágio recarimba", () => {
    const antes = psql(`select stage_changed_at from crm_leads where id='${LEAD}';`);
    psql(`update crm_leads set stage_id='${STAGE_B}' where id='${LEAD}';`);
    const depois = psql(`select stage_changed_at from crm_leads where id='${LEAD}';`);
    expect(depois).not.toBe(antes);
  });

  it("mudar QUALQUER outra coisa não recarimba — senão o relógio mentiria", () => {
    const antes = psql(`select stage_changed_at from crm_leads where id='${LEAD}';`);
    psql(`update crm_leads set title='Lead 0071 renomeado' where id='${LEAD}';`);
    expect(psql(`select stage_changed_at from crm_leads where id='${LEAD}';`)).toBe(antes);
  });
});

describe("0071 — realtime", () => {
  it("crm_lead_activities está publicada (o dossiê assina filtrado por lead_id)", () => {
    expect(
      psql(`select count(*) from pg_publication_tables where pubname='supabase_realtime' and tablename='crm_lead_activities';`),
    ).toBe("1");
  });

  it("crm_leads continua publicada — é por ela que o board recebe o card se movendo", () => {
    expect(
      psql(`select count(*) from pg_publication_tables where pubname='supabase_realtime' and tablename='crm_leads';`),
    ).toBe("1");
  });
});

describe("0071 — LGPD: o porquê morre junto, o lastro fica", () => {
  const CONTATO = "0071aaaa-7777-4000-8000-000000000001";
  const LEAD_PII = "0071aaaa-5555-4000-8000-000000000002";
  const ATIV_PII = "0071aaaa-6666-4000-8000-000000000003";

  beforeAll(() => {
    psql(`
      insert into contacts (id, organization_id, name, display_name, phone_number)
      values ('${CONTATO}', '${ORG}', 'Fulano de Tal', 'Fulano', '+5511999990000')
      on conflict (id) do nothing;

      insert into crm_leads (id, organization_id, pipeline_id, stage_id, title, contact_id)
      values ('${LEAD_PII}', '${ORG}', '${PIPELINE}', '${STAGE_A}', 'Negócio do Fulano', '${CONTATO}')
      on conflict (id) do nothing;

      -- reason com PII (é texto livre exibido na timeline) e evidence com ids.
      insert into crm_lead_activities
        (id, organization_id, lead_id, contact_id, type, source_module, actor_kind, reason, evidence)
      values ('${ATIV_PII}', '${ORG}', '${LEAD_PII}', '${CONTATO}', 'note_added', 'ai', 'ai',
              'cliente pediu retorno no celular da esposa, 11 99999-0000',
              '{"run_ids":["44444444-4444-4444-8444-444444444444"]}'::jsonb)
      on conflict (id) do update set
        reason = 'cliente pediu retorno no celular da esposa, 11 99999-0000',
        evidence = '{"run_ids":["44444444-4444-4444-8444-444444444444"]}'::jsonb;
    `);
    psql(`select fn_lgpd_cascade_redact_contact('${ORG}'::uuid, '${CONTATO}'::uuid, gen_random_uuid());`);
  });

  it("reason vira null — texto livre na timeline pode carregar PII", () => {
    expect(psql(`select coalesce(reason, '(null)') from crm_lead_activities where id='${ATIV_PII}';`))
      .toBe("(null)");
  });

  it("evidence SOBREVIVE — são ids de execução, não dado pessoal", () => {
    expect(psql(`select jsonb_array_length(evidence->'run_ids') from crm_lead_activities where id='${ATIV_PII}';`))
      .toBe("1");
  });

  it("actor_kind sobrevive: quem agiu não é PII, e some-lo apagaria a auditoria", () => {
    expect(psql(`select actor_kind from crm_lead_activities where id='${ATIV_PII}';`)).toBe("ai");
  });

  it("o resto do cascade seguiu funcionando (payload/metadata zerados, contato anonimizado)", () => {
    expect(psql(`select payload::text || '|' || metadata::text from crm_lead_activities where id='${ATIV_PII}';`))
      .toBe("{}|{}");
    expect(psql(`select is_anonymized from contacts where id='${CONTATO}';`)).toBe("t");
  });
});
