/**
 * A PÁGINA, O TOKEN E A BUSCA DO LEAD ADS SÓ MUDAM PELO SERVIDOR (migration 9320).
 *
 * O lead do formulário da Meta é roteado pela página gravada na fonte, para
 * qualquer organização da instalação. A rota da fonte confere quem pede (admin)
 * e que a página é a que o token lê; a policy `webhook_sources_manager_write`,
 * porém, deixa o manager escrever a linha inteira pela sessão. O gatilho
 * `trg_fonte_do_lead_ads_so_pelo_servidor` fecha esse caminho: pela sessão as
 * três colunas não nascem preenchidas nem mudam — nem para o admin, que passa
 * pela rota. O resto da fonte segue editável pela sessão, como sempre.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { GOV_ADMIN, GOV_MANAGER, GOV_ORG, GOV_PIPELINE, GOV_STAGE, seedGov, sql, writeCountAs } from "./gov-helpers";

const FONTE = "ffffffff-9320-4000-8000-000000000001";
const FONTE_PROBE = "ffffffff-9320-4000-8000-000000000002";

function recusa(userId: string, dml: string): string {
  try {
    writeCountAs(userId, dml);
    return "passou";
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? String(err);
    return stderr.includes("webhook_source_meta_server_only") ? "recusada" : stderr;
  }
}

beforeAll(() => {
  seedGov();
  sql(`
    insert into public.webhook_sources (id, organization_id, name, path_token, default_pipeline_id, default_stage_id)
      values ('${FONTE}', '${GOV_ORG}', 'Anúncios', 'tok-${FONTE}', '${GOV_PIPELINE}', '${GOV_STAGE}')
      on conflict do nothing;
  `);
});

describe("webhook_sources — a página do Lead Ads só muda pelo servidor", () => {
  it("manager não grava a página pela sessão", () => {
    expect(
      recusa(GOV_MANAGER, `update public.webhook_sources set meta_page_id = '1029384756' where id = '${FONTE}'`),
    ).toBe("recusada");
  });

  it("nem o admin, nem o token nem a busca — o caminho é a rota", () => {
    expect(
      recusa(GOV_ADMIN, `update public.webhook_sources set meta_page_id = '1029384756' where id = '${FONTE}'`),
    ).toBe("recusada");
    expect(
      recusa(GOV_ADMIN, `update public.webhook_sources set meta_lead_retrieval = true where id = '${FONTE}'`),
    ).toBe("recusada");
    expect(
      recusa(GOV_ADMIN, `update public.webhook_sources set meta_page_token_encrypted = '\\x00'::bytea where id = '${FONTE}'`),
    ).toBe("recusada");
  });

  it("fonte nova pela sessão não nasce reivindicando página", () => {
    expect(
      recusa(
        GOV_MANAGER,
        `insert into public.webhook_sources (id, organization_id, name, path_token, default_pipeline_id, default_stage_id, meta_page_id)
         values ('${FONTE_PROBE}', '${GOV_ORG}', 'Probe', 'tok-${FONTE_PROBE}', '${GOV_PIPELINE}', '${GOV_STAGE}', '555')`,
      ),
    ).toBe("recusada");
  });

  it("o resto da fonte segue editável pela sessão", () => {
    expect(writeCountAs(GOV_MANAGER, `update public.webhook_sources set name = 'Anúncios 2' where id = '${FONTE}'`)).toBe(1);
  });

  it("o servidor grava a página", () => {
    sql(`update public.webhook_sources set meta_page_id = '1029384756' where id = '${FONTE}';`);
    const out = sql(`select meta_page_id from public.webhook_sources where id = '${FONTE}';`);
    expect(out).toContain("1029384756");
    sql(`update public.webhook_sources set meta_page_id = null where id = '${FONTE}';`);
  });
});
