/**
 * PEDIDO DE LGPD SEM E-MAIL VIRA REVISÃO PENDENTE — E NÃO "PROCESSANDO" PARA SEMPRE (0651).
 *
 * ## O defeito (medido na prova pela tela do #2669, vps-teste, 11/10)
 *
 * Self-host sem transporte de e-mail: o `lgpd-export-worker` gravava
 * `status = 'pending_review'`, o CHECK `lgpd_requests_status_check` só aceitava
 * received/processing/completed/failed/expired, o update morria em 23514 e o
 * pedido ficava em `processing` com `result` nulo — o PDF no bucket sem ponteiro.
 *
 * ## Qual caso guarda o quê
 *
 *   1. o CHECK do banco que o self-hoster aplica ACEITA `pending_review` — o
 *      conserto em si. Vermelho com o apêndice da 0651 fora do baseline.
 *   2. e continua RECUSANDO valor fora do vocabulário — sem ele, "conserto" que
 *      apagasse o CHECK passaria no caso 1.
 *   3. o backfill, EXECUTADO do bloco do baseline numa transação revertida:
 *      os pedidos presos com prova no audit (exportação sem transporte,
 *      exportação sem endereço, redact sem pegada local, tenant com falha
 *      parcial) saem de `processing` com o `result` que o worker gravaria; o
 *      preso SEM prova e o pedido de outra organização com prova alheia ficam.
 *   4. migration e apêndice carregam o MESMO bloco: a cadeia e o kit self-host
 *      curam igual.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { GOV_ORG, lastLine, seedGov, sql } from "./gov-helpers";

const MIGRATION =
  "supabase/migrations/20261013000001_0651_pedido_lgpd_sem_email_vira_revisao_pendente.sql";
const MARCADOR_INICIO = "-- ---- pedido de LGPD sem e-mail vira revisão pendente (migration 0651) ----";
const MARCADOR_PROXIMO = "\n-- ---- ";

const ler = (relativo: string) => readFileSync(join(process.cwd(), relativo), "utf8");

/** O `do $$ … end $$;` de um texto — o único que cada arquivo tem para este conserto. */
function blocoDo(texto: string, origem: string): string {
  const inicio = texto.indexOf("\ndo $$\n");
  const fim = texto.indexOf("\nend $$;", inicio);
  if (inicio < 0 || fim < 0) throw new Error(`bloco do $$ não encontrado em ${origem}`);
  const bloco = texto.slice(inicio + 1, fim + "\nend $$;".length);
  if (!/lgpd_requests_status_check/.test(bloco) || !/'lgpd\.tenant_redacted'/.test(bloco)) {
    throw new Error(`bloco extraído de ${origem} está truncado (extração quebrada)`);
  }
  return bloco;
}

function blocoDoApendice(): string {
  const baseline = ler("supabase/baseline.sql");
  const inicio = baseline.indexOf(MARCADOR_INICIO);
  if (inicio < 0) throw new Error(`marcador ${MARCADOR_INICIO} não encontrado em supabase/baseline.sql`);
  const fim = baseline.indexOf(MARCADOR_PROXIMO, inicio + MARCADOR_INICIO.length);
  return blocoDo(fim < 0 ? baseline.slice(inicio) : baseline.slice(inicio, fim), "baseline.sql");
}

// Namespace pela migration (0651).
const ORG_ALHEIA = "06510000-0000-4000-8000-0000000000aa";
const P_SEM_TRANSPORTE = "06510000-1111-4000-8000-000000000001";
const P_SEM_ENDERECO = "06510000-1111-4000-8000-000000000002";
const P_SEM_PEGADA = "06510000-1111-4000-8000-000000000003";
const P_TENANT = "06510000-1111-4000-8000-000000000004";
const P_SEM_PROVA = "06510000-1111-4000-8000-000000000005";
const P_PROVA_ALHEIA = "06510000-1111-4000-8000-000000000006";
const P_TESTE_CHECK = "06510000-1111-4000-8000-000000000007";

function pedido(id: string, tipo: string, escopo = "contact"): string {
  return `insert into public.lgpd_requests
            (id, organization_id, request_type, source, status, attempts, due_at, scope)
          values ('${id}', '${GOV_ORG}', '${tipo}', 'manual', 'processing', 1, now() + interval '5 days', '${escopo}');`;
}

function prova(id: string, acao: string, metadata: object, org = GOV_ORG): string {
  return `insert into public.api_audit_log (organization_id, action, resource_type, resource_id, bypassed_rls, metadata)
          values ('${org}', '${acao}', 'lgpd_request', '${id}', true, '${JSON.stringify(metadata)}'::jsonb);`;
}

/** Planta os presos, re-aplica o bloco do baseline e devolve as linhas — tudo revertido. */
function depoisDoBackfill(): Record<string, { status: string; error_message: string | null; result: unknown; completed_at: string | null; cascaded_to: unknown }> {
  const saida = sql(`
    begin;
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG_ALHEIA}', 'org-alheia-0651', 'Org alheia 0651', 'Org alheia 0651');
    ${pedido(P_SEM_TRANSPORTE, "data_request")}
    ${prova(P_SEM_TRANSPORTE, "lgpd.export_generated", {
      sha256: "abc",
      signed_pades: false,
      warning: "email_not_configured",
      delivered_to_hash: "hash-do-titular",
    })}
    ${pedido(P_SEM_ENDERECO, "data_request")}
    ${prova(P_SEM_ENDERECO, "lgpd.export_generated", {
      sha256: "def",
      signed_pades: false,
      warning: "pades_key_missing",
      delivery: "pending_review_no_email",
    })}
    ${pedido(P_SEM_PEGADA, "redact")}
    ${prova(P_SEM_PEGADA, "lgpd.redact_no_local_footprint", { external_customer_id_present: true })}
    ${pedido(P_TENANT, "store_redact", "tenant")}
    ${prova(P_TENANT, "lgpd.tenant_redacted", {
      processed: 10,
      failed_count: 2,
      aggregate_counts: { contacts: 8 },
      callback_status: "not_implemented",
      attempts: 1,
      partial_failure: true,
    })}
    ${pedido(P_SEM_PROVA, "data_request")}
    ${pedido(P_PROVA_ALHEIA, "data_request")}
    ${prova(P_PROVA_ALHEIA, "lgpd.export_generated", { sha256: "x", signed_pades: false, warning: "email_not_configured" }, ORG_ALHEIA)}
    ${blocoDoApendice()}
    select json_object_agg(id, json_build_object(
             'status', status, 'error_message', error_message, 'result', result,
             'completed_at', completed_at, 'cascaded_to', cascaded_to))
      from public.lgpd_requests where id::text like '06510000-1111-%';
    rollback;
  `);
  const linha = saida.split("\n").find((l) => l.trim().startsWith("{"));
  if (!linha) throw new Error(`nenhum json na saída do psql: ${saida}`);
  return JSON.parse(linha);
}

beforeAll(() => {
  seedGov();
  sql(`delete from public.lgpd_requests where id::text like '06510000-1111-%';`);
});

describe("0651 — pending_review no CHECK de lgpd_requests", () => {
  it("1. o CHECK aceita pending_review", () => {
    const saida = sql(`
      begin;
      ${pedido(P_TESTE_CHECK, "data_request")}
      update public.lgpd_requests set status = 'pending_review' where id = '${P_TESTE_CHECK}';
      select status from public.lgpd_requests where id = '${P_TESTE_CHECK}';
      rollback;
    `);
    expect(saida.split("\n").map((l) => l.trim())).toContain("pending_review");
  });

  it("2. e continua recusando valor fora do vocabulário", () => {
    expect(() =>
      sql(`
        begin;
        ${pedido(P_TESTE_CHECK, "data_request")}
        update public.lgpd_requests set status = 'em_revisao' where id = '${P_TESTE_CHECK}';
        rollback;
      `),
    ).toThrow(/lgpd_requests_status_check/);
    expect(lastLine(sql(`select count(*) from public.lgpd_requests where id = '${P_TESTE_CHECK}';`))).toBe("0");
  });

  it("3. o bloco do baseline cura os presos com prova e só eles", () => {
    const r = depoisDoBackfill();

    expect(r[P_SEM_TRANSPORTE]).toMatchObject({
      status: "pending_review",
      error_message: "email_not_configured",
      result: {
        pdf_path: `${GOV_ORG}/${P_SEM_TRANSPORTE}/report.pdf`,
        json_path: `${GOV_ORG}/${P_SEM_TRANSPORTE}/data.json`,
        sha256: "abc",
        signed_pades: false,
        warning: "pades_key_missing",
        delivered_to_hash: "hash-do-titular",
      },
    });
    expect(r[P_SEM_ENDERECO]).toMatchObject({
      status: "pending_review",
      error_message: "no_delivery_email",
      result: { pdf_path: `${GOV_ORG}/${P_SEM_ENDERECO}/report.pdf`, sha256: "def", warning: "pades_key_missing" },
    });
    expect(r[P_SEM_ENDERECO]!.result).not.toHaveProperty("delivered_to_hash");
    expect(r[P_SEM_PEGADA]).toMatchObject({
      status: "pending_review",
      error_message: "no_local_footprint",
      result: { reason: "no_local_footprint" },
    });
    expect(r[P_TENANT]).toMatchObject({
      status: "pending_review",
      error_message: "partial_failure",
      cascaded_to: { contacts: 8 },
      result: { scope: "tenant", processed: 10, failed_contacts_count: 2, organization_status: "redacted" },
    });
    expect(r[P_TENANT]!.completed_at).not.toBeNull();

    // Sem prova, nada se inventa; prova de OUTRA organização não alcança o pedido.
    expect(r[P_SEM_PROVA]).toMatchObject({ status: "processing", result: null });
    expect(r[P_PROVA_ALHEIA]).toMatchObject({ status: "processing", result: null });
  });

  it("4. migration e apêndice do baseline carregam o mesmo bloco", () => {
    expect(blocoDoApendice()).toBe(blocoDo(ler(MIGRATION), MIGRATION));
  });
});
