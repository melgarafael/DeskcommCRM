import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import {
  checkAgentePublicado,
  checkCampanhas,
  checkCoberturaDosCaminhos,
  checkDenyByDefault,
  checkImpactoConversas,
  checkPlanoDeEscrita,
  checkQueryElegibilidade,
  checkRespondiAutoriza,
  checkSchema0203,
  type CtxAtivacao,
} from "../../scripts/lib/gate-ativacao";

/**
 * O preflight do `scripts/ativar-gate-elegibilidade-ia.ts` contra Postgres REAL
 * (baseline.sql aplicado pelo harness). Prova que:
 *   - a query base da elegibilidade roda no schema do produto;
 *   - "agente publicado" é detectado;
 *   - a contagem de conversas que perdem a IA está certa;
 *   - contato antigo / sem origem NÃO é autorizado em modo allowlist;
 *   - campanha genérica é RECUSADA (FAIL), específica passa;
 *   - o plano de escrita toca SÓ channel_sessions.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) throw new Error("TEST_DB_CONTAINER não setado — rode via scripts/test-db.sh");
const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`, max: 2 });

const P = "d1a7e000-0000-4000-8000-0000000000";
const ORG = `${P}01`;
const CANAL = `${P}02`;
const OUTRO_CANAL = `${P}03`;
const AGENT = `${P}04`;
const VERSION = `${P}05`;
const PIPE = `${P}06`;
const STAGE = `${P}07`;
const WSRC = `${P}08`;
// contatos
const CT_AUTORIZADO = `${P}10`;
const CT_NAO_AUTORIZADO = `${P}11`;
const CT_ANTIGO = `${P}12`;
const CT_HANDOFF = `${P}13`;
// conversas
const CV_AUTORIZADO = `${P}20`;
const CV_NAO_AUTORIZADO = `${P}21`;
const CV_ANTIGO = `${P}22`;
const CV_HANDOFF = `${P}23`;

async function q(texto: string, params: unknown[] = []): Promise<Array<Record<string, unknown>>> {
  return (await pool.query(texto, params)).rows;
}

function ctx(over: Partial<CtxAtivacao> = {}): CtxAtivacao {
  return {
    pool: { query: (t, p) => pool.query(t, p as unknown[]) },
    organizationId: ORG,
    channelSessionId: CANAL,
    channelMetadata: {},
    raiz: process.cwd(),
    ttlMs: 21 * 86_400_000,
    alvoModo: "allowlist",
    rollback: false,
    opcoes: { permitirSemAgente: false, campanhasPerigosasOk: false, tamAmostra: 25 },
    ...over,
  };
}

beforeAll(async () => {
  await q(
    `insert into organizations (id, slug, legal_name, display_name, settings)
       values ($1,'gate-ativ','Gate Ativ','Gate Ativ','{}'::jsonb) on conflict do nothing`,
    [ORG],
  );
  for (const [id, nome] of [
    [CANAL, "gate-ativ-canal"],
    [OUTRO_CANAL, "gate-ativ-outro"],
  ] as const) {
    await q(
      `do $$ begin
         insert into channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
           values ('${id}', '${ORG}', '${nome}', '\\x00'::bytea);
       exception when unique_violation then null; end $$`,
    );
  }
  await q(
    `insert into ai_agents (id, organization_id, name, system_prompt) values ($1,$2,'Agente Gate','sp') on conflict (id) do nothing`,
    [AGENT, ORG],
  );
  await q(
    `insert into ai_agent_versions (id, organization_id, agent_id, version_number, system_prompt, provider, model, channel_session_id, status, published_at)
       values ($1,$2,$3,1,'sp','anthropic','anthropic/claude-sonnet-4-6',$4,'published',now())
       on conflict (id) do nothing`,
    [VERSION, ORG, AGENT, CANAL],
  );
  await q(`update ai_agents set published_version_id = $2 where id = $1`, [AGENT, VERSION]);
  await q(`insert into crm_pipelines (id, organization_id, name, slug) values ($1,$2,'P','gate-p') on conflict do nothing`, [PIPE, ORG]);
  await q(
    `insert into crm_stages (id, organization_id, pipeline_id, name, slug, position) values ($1,$2,$3,'S','gate-s',1000) on conflict do nothing`,
    [STAGE, ORG, PIPE],
  );

  // contatos
  const agora = Date.now();
  await q(
    `insert into contacts (id, organization_id, display_name, ai_authorized_at, ai_authorized_reason, created_at)
       values
         ($1,$5,'Autorizado',   now(),                              'respondi:form-1:sub-1', now()),
         ($2,$5,'Nao autorizado', null,                              null,                    now()),
         ($3,$5,'Antigo',         null,                              null,                    to_timestamp(${Math.floor(agora / 1000) - 400 * 86400})),
         ($4,$5,'Handoff',        null,                              null,                    now())
       on conflict (id) do update set ai_authorized_at = excluded.ai_authorized_at, ai_authorized_reason = excluded.ai_authorized_reason`,
    [CT_AUTORIZADO, CT_NAO_AUTORIZADO, CT_ANTIGO, CT_HANDOFF, ORG],
  );
  await q(`update contacts set force_human = true where id = $1`, [CT_HANDOFF]);

  // conversas — todas no CANAL
  for (const [cv, ct] of [
    [CV_AUTORIZADO, CT_AUTORIZADO],
    [CV_NAO_AUTORIZADO, CT_NAO_AUTORIZADO],
    [CV_ANTIGO, CT_ANTIGO],
    [CV_HANDOFF, CT_HANDOFF],
  ] as const) {
    await q(
      `insert into conversations (id, organization_id, contact_id, channel_session_id, status, last_inbound_at, last_message_at)
         values ($1,$2,$3,$4,'open', now(), now()) on conflict do nothing`,
      [cv, ORG, ct, CANAL],
    );
  }
});

afterAll(async () => {
  await q(`delete from conversations where organization_id = $1`, [ORG]);
  await q(`update ai_agents set published_version_id = null where organization_id = $1`, [ORG]);
  await q(`delete from ai_agent_versions where organization_id = $1`, [ORG]);
  await q(`delete from ai_agents where organization_id = $1`, [ORG]);
  await q(`delete from webhook_sources where organization_id = $1`, [ORG]);
  await q(`delete from crm_stages where organization_id = $1`, [ORG]);
  await q(`delete from crm_pipelines where organization_id = $1`, [ORG]);
  await q(`delete from contacts where organization_id = $1`, [ORG]);
  await q(`delete from channel_sessions where organization_id = $1`, [ORG]);
  await q(`delete from organizations where id = $1`, [ORG]);
  await pool.end();
});

describe("preflight do ativar-gate contra Postgres real", () => {
  it("checkSchema0203 · PASS (0203 está no baseline)", async () => {
    const r = await checkSchema0203(ctx());
    expect(r.status).toBe("PASS");
  });

  it("checkQueryElegibilidade · PASS e roda a regra numa conversa real", async () => {
    const r = await checkQueryElegibilidade(ctx());
    expect(r.status).toBe("PASS");
    expect(r.linhas?.join("\n")).toMatch(/query base .* resolveu/);
    expect(r.linhas?.join("\n")).toMatch(/conversa real .*com allowlist/);
  });

  it("checkAgentePublicado · PASS quando há versão publicada no canal", async () => {
    expect((await checkAgentePublicado(ctx())).status).toBe("PASS");
  });

  it("checkAgentePublicado · FAIL num canal sem agente, WARN com --permitir-sem-agente", async () => {
    expect((await checkAgentePublicado(ctx({ channelSessionId: OUTRO_CANAL }))).status).toBe("FAIL");
    const warn = await checkAgentePublicado(
      ctx({ channelSessionId: OUTRO_CANAL, opcoes: { permitirSemAgente: true, campanhasPerigosasOk: false, tamAmostra: 25 } }),
    );
    expect(warn.status).toBe("WARN");
  });

  it("checkImpactoConversas · conta certo quem perde / mantém / já bloqueada", async () => {
    const r = await checkImpactoConversas(ctx());
    // CV_NAO_AUTORIZADO e CV_ANTIGO perdem (2); CV_AUTORIZADO mantém (1);
    // CV_HANDOFF já bloqueada por force_human (1).
    expect(r.detalhe).toMatch(/^2 conversa\(s\) deixam de ser atendidas/);
    expect(r.detalhe).toMatch(/1 seguem elegíveis/);
    expect(r.detalhe).toMatch(/1 já não recebiam IA hoje/);
  });

  it("checkDenyByDefault · contato antigo e simulações NÃO autorizam; PASS", async () => {
    const r = await checkDenyByDefault(ctx());
    expect(r.status).toBe("PASS");
    expect(r.linhas?.join("\n")).toMatch(/não autorizado \(sem_autorizacao\)/);
    expect(r.linhas?.join("\n")).not.toMatch(/AUTORIZADO\?!/);
    expect(r.linhas?.join("\n")).toMatch(/mensagem nova, contato nunca autorizado.*não responde/);
    expect(r.linhas?.join("\n")).toMatch(/mais velha que o TTL.*não responde \(autorizacao_expirada\)/);
  });

  it("checkDenyByDefault · autorização com reason fora do vocabulário → FAIL", async () => {
    await q(`update contacts set ai_authorized_reason = 'importado_planilha' where id = $1`, [CT_AUTORIZADO]);
    const r = await checkDenyByDefault(ctx());
    await q(`update contacts set ai_authorized_reason = 'respondi:form-1:sub-1' where id = $1`, [CT_AUTORIZADO]);
    expect(r.status).toBe("FAIL");
    expect(r.detalhe).toMatch(/fora do produto/);
  });

  it("checkCampanhas · genérica → FAIL; específica → PASS; presa a outro canal → PASS", async () => {
    await q(
      `update organizations set settings = jsonb_set(settings,'{campanhas_whatsapp}', $2::jsonb) where id = $1`,
      [ORG, JSON.stringify([{ id: "generica", match: { tipo: "contains", valor: "bom dia" } }])],
    );
    expect((await checkCampanhas(ctx())).status).toBe("FAIL");

    await q(
      `update organizations set settings = jsonb_set(settings,'{campanhas_whatsapp}', $2::jsonb) where id = $1`,
      [ORG, JSON.stringify([{ id: "generica-outro", channel_session_id: OUTRO_CANAL, match: { tipo: "contains", valor: "bom dia" } }])],
    );
    expect((await checkCampanhas(ctx())).status).toBe("PASS");

    await q(
      `update organizations set settings = jsonb_set(settings,'{campanhas_whatsapp}', $2::jsonb) where id = $1`,
      [ORG, JSON.stringify([{ id: "boa", match: { tipo: "contains", valor: "quero saber sobre o plano imobiliario premium" } }])],
    );
    expect((await checkCampanhas(ctx())).status).toBe("PASS");

    await q(`update organizations set settings = settings - 'campanhas_whatsapp' where id = $1`, [ORG]);
  });

  it("checkRespondiAutoriza · WARN sem fonte, PASS com fonte ativa", async () => {
    expect((await checkRespondiAutoriza(ctx())).status).toBe("WARN");
    await q(
      `insert into webhook_sources (id, organization_id, name, path_token, default_pipeline_id, default_stage_id)
         values ($1,$2,'Respondi','tok-gate-ativ',$3,$4) on conflict do nothing`,
      [WSRC, ORG, PIPE, STAGE],
    );
    const r = await checkRespondiAutoriza(ctx());
    await q(`delete from webhook_sources where id = $1`, [WSRC]);
    expect(r.status).toBe("PASS");
    expect(r.linhas?.join("\n")).toMatch(/service_role pode UPDATE contacts.ai_authorized_at/);
  });

  it("checkCoberturaDosCaminhos · PASS (checkout, todos os caminhos com o marcador)", async () => {
    const r = await checkCoberturaDosCaminhos(ctx());
    expect(["PASS", "INFO"]).toContain(r.status);
    expect(r.status).not.toBe("FAIL");
  });

  it("checkPlanoDeEscrita · descreve a única escrita, NÃO toca contacts", () => {
    const r = checkPlanoDeEscrita(ctx());
    const txt = r.linhas?.join("\n") ?? "";
    expect(txt).toMatch(/update channel_sessions/);
    expect(txt).toMatch(/ZERO autorização em massa/);
    expect(txt).not.toMatch(/update contacts/);
    expect(txt).not.toMatch(/update conversations/);
  });
});
