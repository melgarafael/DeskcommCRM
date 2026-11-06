import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { drainTick } from "@/lib/agent-engine/edge/crm/drain";
import { createLogger } from "@/lib/agent-engine/obs/logger";
import { haQuemAtendaASessao } from "@/lib/ai/agents/quem-atende-a-sessao";
import {
  ANCORA_ISO_8601,
  haLeitorDaDescricao,
  organizacoesComLeituraAdiada,
  reabrirLeituraAdiada,
} from "@/lib/messaging/media/leitura-adiada";

import { indexExists } from "./gov-helpers";

/**
 * FOTO ADIADA POR FALTA DE LEITOR, NUM POSTGRES DE VERDADE.
 *
 * Com `MEDIA_VISION_WITHOUT_READER=defer` (o padrão), a foto de uma empresa sem
 * leitor fica `skipped` com `metadata.derivacao_adiada`. O que só o banco prova:
 *
 *  (a) a matriz do predicado `haLeitorDaDescricao` — cada componente sozinho
 *      liga, e os "quase" (agente arquivado, token revogado/vencido) não; o
 *      agente só conta com "ver as fotos" ligado (9108) na versão que vale, o
 *      caso de agente no ar, o fluxo e a inscrição que um agente conduz não
 *      contam sozinhos, e o caso de agente FORA do ar conta (a persona padrão vê);
 *  (b) a paridade com o portão do dreno: onde o dreno deixaria um turno rodar,
 *      a empresa TEM leitor — a trava nunca tira a descrição de quem atende;
 *  (c) a reabertura: limpa a marca, ancora o pedido, emite UM evento, é
 *      idempotente, e não toca a linha zerada pela LGPD/retenção, a de outra
 *      organização nem a de outra conversa;
 *  (d) o índice parcial existe;
 *  (e) o dreno de verdade reabre a foto antiga e ADIA o turno — o cast da
 *      âncora roda sobre a linha reaberta; o agente que não vê imagens não
 *      reabre numa empresa sem quem veja; e o roteador que pode entregar o turno
 *      a um agente que vê faz o dreno reabrir mesmo com o da sessão desligado;
 *  (f) âncora FORJADA (lixo, data que não existe, `infinity`, data futura) não
 *      derruba a consulta de espera nem segura o turno para sempre;
 *  (g) o padrão da âncora, no motor de regex do PRÓPRIO Postgres: casa o que
 *      `now()` grava em qualquer fuso, e tudo o que casa converte sem erro.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:invariants` (scripts/test-db.sh)");
}
const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 2,
});
const log = createLogger();

afterAll(async () => {
  await pool.end();
});

async function novaOrg(settings: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name, settings)
     values ($1, $2, 'Leitura Adiada', 'Leitura Adiada', $3::jsonb)`,
    [id, `leitura-adiada-${id.slice(0, 8)}`, JSON.stringify(settings)],
  );
  return id;
}

interface Conversa {
  session: string;
  contact: string;
  conv: string;
}

async function novaConversa(org: string): Promise<Conversa> {
  const session = randomUUID();
  const contact = randomUUID();
  const conv = randomUUID();
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1, $2, $3, 'WORKING', '\\x00'::bytea)`,
    [session, org, `leitura-${session.slice(0, 8)}`],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number) values ($1, $2, 'Cliente', $3)`,
    [contact, org, `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
     values ($1, $2, $3, $4, 'open', false)`,
    [conv, org, contact, session],
  );
  return { session, contact, conv };
}

async function novoAgente(
  org: string,
  opts: {
    publicadoNa?: string;
    arquivado?: boolean;
    pausado?: boolean;
    /** `image_vision_enabled` da versão publicada; ausente = o default do banco. */
    visao?: boolean;
    /** Um rascunho (versão 2, ou 1 sem publicada) com esta opção. */
    rascunho?: { visao: boolean };
  } = {},
): Promise<string> {
  const agent = randomUUID();
  await pool.query(
    `insert into ai_agents (id, organization_id, name, system_prompt, kind)
     values ($1, $2, $3, 'você é um atendente', 'mcp_agent')`,
    [agent, org, `Agente ${agent.slice(0, 8)}`],
  );
  if (opts.publicadoNa) {
    const version = randomUUID();
    await pool.query(
      `insert into ai_agent_versions (id, organization_id, agent_id, version_number, system_prompt,
                                      provider, model, channel_session_id, status, published_at,
                                      image_vision_enabled)
       values ($1, $2, $3, 1, 'você é um atendente', 'anthropic', 'claude-sonnet-4-6', $4, 'published', now(),
               coalesce($5::boolean, true))`,
      [version, org, agent, opts.publicadoNa, opts.visao ?? null],
    );
    await pool.query(`update ai_agents set published_version_id = $1 where id = $2`, [version, agent]);
  }
  if (opts.rascunho) {
    await pool.query(
      `insert into ai_agent_versions (organization_id, agent_id, version_number, system_prompt,
                                      provider, model, status, image_vision_enabled)
       values ($1, $2, $3, 'você é um atendente', 'anthropic', 'claude-sonnet-4-6', 'draft', $4)`,
      [org, agent, opts.publicadoNa ? 2 : 1, opts.rascunho.visao],
    );
  }
  if (opts.arquivado) await pool.query(`update ai_agents set archived_at = now() where id = $1`, [agent]);
  if (opts.pausado) await pool.query(`update ai_agents set paused_at = now() where id = $1`, [agent]);
  return agent;
}

async function novoToken(org: string, estado: "vivo" | "revogado" | "vencido"): Promise<void> {
  const usuario = randomUUID();
  await pool.query(`insert into auth.users (id, email) values ($1, $2)`, [usuario, `${usuario}@invariant.test`]);
  await pool.query(
    `insert into api_tokens (organization_id, created_by, name, prefix, token_hash, scopes, revoked_at, expires_at)
     values ($1, $2, 'integração', $3, decode(md5(random()::text), 'hex'), '[]'::jsonb,
             case when $4 = 'revogado' then now() end,
             case when $4 = 'vencido' then now() - interval '1 day' end)`,
    [org, usuario, `tok_${usuario.slice(0, 8)}`, estado],
  );
}

async function novoFluxo(org: string, status: "active" | "draft"): Promise<{ pointer: string; version: string }> {
  const { rows: v } = await pool.query<{ id: string }>(
    `insert into followup_flow_versions (organization_id, graph) values ($1, '{}'::jsonb) returning id`,
    [org],
  );
  const { rows: p } = await pool.query<{ id: string }>(
    `insert into followup_flow_pointers (organization_id, name, status, active_version_id)
     values ($1, $2, $3, $4) returning id`,
    [org, `fluxo-${randomUUID().slice(0, 8)}`, status, v[0]!.id],
  );
  return { pointer: p[0]!.id, version: v[0]!.id };
}

/** Foto guardada sem descrição, como o media-persist-worker a deixa. */
async function fotoAdiada(
  org: string,
  c: Conversa,
  opts: { path?: string | null; criadaHa?: string } = {},
): Promise<string> {
  const id = randomUUID();
  const path = opts.path === undefined ? `${org}/${c.conv}/${id}.jpg` : opts.path;
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id, type,
                           direction, status, body, sent_via, sent_at, created_at, media_url, media_mime,
                           media_storage_path, media_derived_status, metadata)
     values ($1, $2, $3, $4, $5, 'image', 'inbound', 'delivered', null, 'external_device',
             now() - $7::interval, now() - $7::interval, 'http://waha/files/x.jpg', 'image/jpeg', $6,
             'skipped', jsonb_build_object('media_status', 'stored', 'derivacao_adiada', 'sem_leitor',
                                           'media_derived_motivo', 'sem leitor'))`,
    [id, org, c.conv, c.session, c.contact, path, opts.criadaHa ?? "0 seconds"],
  );
  return id;
}

async function linha(id: string): Promise<{ media_derived_status: string | null; metadata: Record<string, unknown> }> {
  const { rows } = await pool.query(`select media_derived_status, metadata from messages where id = $1`, [id]);
  return rows[0];
}

async function eventosDeDerivacao(messageId: string): Promise<Array<{ payload: { message_id: string }; metadata: { source?: string } }>> {
  const { rows } = await pool.query(
    `select payload, metadata from event_log where event_type = 'media.derive_requested' and entity_id = $1`,
    [messageId],
  );
  return rows;
}

describe("(a) haLeitorDaDescricao — cada componente sozinho", () => {
  it("empresa vazia: sem leitor", async () => {
    expect(await haLeitorDaDescricao(pool, await novaOrg())).toBe(false);
  });

  it("só agente ARQUIVADO: sem leitor", async () => {
    const org = await novaOrg();
    await novoAgente(org, { arquivado: true });
    expect(await haLeitorDaDescricao(pool, org)).toBe(false);
  });

  it.each(["revogado", "vencido"] as const)("só token %s: sem leitor (não autentica)", async (estado) => {
    const org = await novaOrg();
    await novoToken(org, estado);
    expect(await haLeitorDaDescricao(pool, org)).toBe(false);
  });

  it("organização que não existe: na dúvida, tem leitor (deriva)", async () => {
    expect(await haLeitorDaDescricao(pool, randomUUID())).toBe(true);
  });

  const caso = async (org: string, agentId: string | null = null) => {
    const c = await novaConversa(org);
    await pool.query(
      `insert into agent_cases (organization_id, conversation_id, agent_id, title, summary, blocker, status)
       values ($1, $2, $3, 'caso', 'resumo', 'bloqueio', 'awaiting_human')`,
      [org, c.conv, agentId],
    );
  };
  const inscricao = async (org: string, agentId: string | null) => {
    const c = await novaConversa(org);
    const f = await novoFluxo(org, "draft");
    await pool.query(
      `insert into followup_enrollments (organization_id, pointer_id, version_id, contact_id, conversation_id,
                                         current_node_id, status, agent_id)
       values ($1, $2, $3, $4, $5, 't1', 'waiting_reply', $6)`,
      [org, f.pointer, f.version, c.contact, c.conv, agentId],
    );
  };

  const componentes: Array<[string, (org: string) => Promise<unknown>]> = [
    // Sem versão nenhuma não há opção a ler: na dúvida, descreve (como antes).
    ["agente sem versão", (org) => novoAgente(org)],
    ["agente pausado sem versão", (org) => novoAgente(org, { pausado: true })],
    ["agente só em rascunho, com a opção ligada", (org) => novoAgente(org, { rascunho: { visao: true } })],
    ["agente publicado com o padrão do banco (ligado)", async (org) => novoAgente(org, { publicadoNa: (await novaConversa(org)).session })],
    ["agente pausado, publicado ligado", async (org) => novoAgente(org, { publicadoNa: (await novaConversa(org)).session, pausado: true })],
    [
      "um agente desligado e outro ligado",
      async (org) => {
        const c = await novaConversa(org);
        await novoAgente(org, { publicadoNa: c.session, visao: false });
        await novoAgente(org, { publicadoNa: c.session, visao: true });
      },
    ],
    // O nó `ai_classify` da inscrição sem agente lê com o modelo da organização.
    ["inscrição esperando resposta SEM agente (fluxo em rascunho)", (org) => inscricao(org, null)],
    ["token vivo", (org) => novoToken(org, "vivo")],
    [
      "conexão de anúncio",
      (org) =>
        pool.query(`insert into ad_platform_connections (organization_id, platform) values ($1, 'meta_ads')`, [org]),
    ],
  ];

  it.each(componentes)("%s: tem leitor", async (_nome, semear) => {
    const org = await novaOrg();
    expect(await haLeitorDaDescricao(pool, org), "controle: a empresa nasceu sem leitor").toBe(false);
    await semear(org);
    expect(await haLeitorDaDescricao(pool, org)).toBe(true);
  });

  /**
   * "Ver as fotos" DESLIGADO (9108): quem só lê por meio de um agente deixa de
   * pagar a visão. Cada semeadura aqui teria leitor com a opção ligada — é o
   * controle da linha `ligado` logo abaixo de cada uma.
   */
  const semVisao: Array<[string, (org: string, visao: boolean) => Promise<unknown>]> = [
    ["agente publicado", async (org, visao) => novoAgente(org, { publicadoNa: (await novaConversa(org)).session, visao })],
    [
      "agente pausado",
      async (org, visao) => novoAgente(org, { publicadoNa: (await novaConversa(org)).session, visao, pausado: true }),
    ],
    ["agente só em rascunho", (org, visao) => novoAgente(org, { rascunho: { visao } })],
    [
      // A PUBLICADA é a que atende; o rascunho de um agente no ar só roda no "Testar".
      "agente publicado com a opção no rascunho invertida",
      async (org, visao) =>
        novoAgente(org, { publicadoNa: (await novaConversa(org)).session, visao, rascunho: { visao: !visao } }),
    ],
    [
      "caso aberto do agente",
      async (org, visao) => caso(org, await novoAgente(org, { publicadoNa: (await novaConversa(org)).session, visao })),
    ],
    [
      "fluxo de follow-up ativo",
      async (org, visao) => {
        await novoAgente(org, { publicadoNa: (await novaConversa(org)).session, visao });
        await novoFluxo(org, "active");
      },
    ],
    [
      "inscrição conduzida pelo agente",
      async (org, visao) =>
        inscricao(org, await novoAgente(org, { publicadoNa: (await novaConversa(org)).session, visao })),
    ],
  ];

  it.each(semVisao)("%s com a opção DESLIGADA: sem leitor", async (_nome, semear) => {
    const org = await novaOrg();
    await semear(org, false);
    expect(await haLeitorDaDescricao(pool, org)).toBe(false);
  });

  it.each(semVisao)("controle — %s com a opção ligada: tem leitor", async (_nome, semear) => {
    const org = await novaOrg();
    await semear(org, true);
    expect(await haLeitorDaDescricao(pool, org)).toBe(true);
  });

  // A conversa do caso responde à equipe com a persona padrão da organização
  // quando o agente do caso não está no ar, e a persona padrão vê as fotos.
  // Cada agente aqui tem a opção DESLIGADA: quem liga o leitor é o caso.
  const casoForaDoAr: Array<[string, (org: string) => Promise<string | null>]> = [
    ["sem agente", async () => null],
    ["de agente arquivado", async (org) => novoAgente(org, { publicadoNa: (await novaConversa(org)).session, visao: false, arquivado: true })],
    ["de agente pausado", async (org) => novoAgente(org, { publicadoNa: (await novaConversa(org)).session, visao: false, pausado: true })],
    ["de agente sem versão publicada", (org) => novoAgente(org, { rascunho: { visao: false } })],
  ];

  it.each(casoForaDoAr)("caso aberto %s: tem leitor (a persona padrão vê a foto)", async (_nome, agente) => {
    const org = await novaOrg();
    const agentId = await agente(org);
    expect(await haLeitorDaDescricao(pool, org), "controle: sem o caso, sem leitor").toBe(false);
    await caso(org, agentId);
    expect(await haLeitorDaDescricao(pool, org)).toBe(true);
  });

  it("fluxo ativo sem agente nenhum não conta sozinho (lê por meio da inscrição)", async () => {
    const org = await novaOrg();
    await novoFluxo(org, "active");
    expect(await haLeitorDaDescricao(pool, org)).toBe(false);
  });

  it("agente desligado não cala o leitor sem agente: com token vivo, tem leitor", async () => {
    const org = await novaOrg();
    await novoAgente(org, { publicadoNa: (await novaConversa(org)).session, visao: false });
    await novoToken(org, "vivo");
    expect(await haLeitorDaDescricao(pool, org)).toBe(true);
  });

  it("modo external: tem leitor", async () => {
    expect(await haLeitorDaDescricao(pool, await novaOrg({ ai_dispatch_mode: "external" }))).toBe(true);
  });

  it("venda pelo canal ligada: tem leitor", async () => {
    expect(await haLeitorDaDescricao(pool, await novaOrg({ conversions: { report_via_channel: true } }))).toBe(true);
  });
});

describe("(b) paridade com o portão do dreno", () => {
  it("onde o dreno deixaria o turno rodar, a empresa TEM leitor", async () => {
    const comAgente = await novaOrg();
    const c1 = await novaConversa(comAgente);
    await novoAgente(comAgente, { publicadoNa: c1.session });

    const comRoteador = await novaOrg();
    const c2 = await novaConversa(comRoteador);
    const longe = await novaConversa(comRoteador);
    const membro = await novoAgente(comRoteador, { publicadoNa: longe.session });
    const router = randomUUID();
    await pool.query(
      `insert into ai_routers (id, organization_id, name, channel_session_id, is_active)
       values ($1, $2, 'Roteador', $3, true)`,
      [router, comRoteador, c2.session],
    );
    await pool.query(
      `insert into ai_router_members (organization_id, router_id, agent_id, intent_name, intent_description)
       values ($1, $2, $3, 'suporte', 'dúvidas')`,
      [comRoteador, router, membro],
    );

    for (const [org, session] of [
      [comAgente, c1.session],
      [comRoteador, c2.session],
    ] as const) {
      expect(await haQuemAtendaASessao(pool, org, session), "controle: o portão abre neste cenário").toBe(true);
      expect(await haLeitorDaDescricao(pool, org), "o dreno atenderia, mas a trava adiaria a foto").toBe(true);
    }
  });
});

describe("(c) reabrirLeituraAdiada", () => {
  it("reabre só a foto da conversa, uma vez, com âncora e um evento — e não toca o resto", async () => {
    const org = await novaOrg();
    const c1 = await novaConversa(org);
    const c2 = await novaConversa(org);
    const outraOrg = await novaOrg();
    const cx = await novaConversa(outraOrg);

    const alvo = await fotoAdiada(org, c1);
    const zerada = await fotoAdiada(org, c1, { path: null });
    const deOutraConversa = await fotoAdiada(org, c2);
    const deOutraOrg = await fotoAdiada(outraOrg, cx);

    expect(await reabrirLeituraAdiada(pool, org, { conversationId: c1.conv, limite: 100 })).toBe(1);

    const reaberta = await linha(alvo);
    expect(reaberta.media_derived_status).toBeNull();
    expect(reaberta.metadata).not.toHaveProperty("derivacao_adiada");
    expect(reaberta.metadata).not.toHaveProperty("media_derived_motivo");
    expect(reaberta.metadata.media_status, "o resto do metadata fica").toBe("stored");
    const pedida = new Date(String(reaberta.metadata.derivacao_pedida_em)).getTime();
    expect(Math.abs(Date.now() - pedida)).toBeLessThan(5_000);

    const eventos = await eventosDeDerivacao(alvo);
    expect(eventos).toHaveLength(1);
    expect(eventos[0]!.payload.message_id).toBe(alvo);
    expect(eventos[0]!.metadata.source).toBe("leitura_adiada");

    // Idempotente: a marca já saiu, nada reabre, nenhum evento a mais.
    expect(await reabrirLeituraAdiada(pool, org, { conversationId: c1.conv, limite: 100 })).toBe(0);
    expect(await eventosDeDerivacao(alvo)).toHaveLength(1);

    for (const intocada of [zerada, deOutraConversa, deOutraOrg]) {
      const l = await linha(intocada);
      expect(l.media_derived_status).toBe("skipped");
      expect(l.metadata.derivacao_adiada).toBe("sem_leitor");
      expect(await eventosDeDerivacao(intocada)).toHaveLength(0);
    }

    // Sem filtro de conversa (o cron): alcança a outra conversa da MESMA empresa.
    expect(await reabrirLeituraAdiada(pool, org, { limite: 100 })).toBe(1);
    expect((await linha(deOutraConversa)).media_derived_status).toBeNull();
    expect((await linha(deOutraOrg)).metadata.derivacao_adiada, "outra organização segue adiada").toBe("sem_leitor");
  });

  it("com maxIdadeDias, a foto mais velha que a janela fica adiada; sem ele, é reaberta", async () => {
    const org = await novaOrg();
    const c = await novaConversa(org);
    const recente = await fotoAdiada(org, c, { criadaHa: "6 days" });
    const velha = await fotoAdiada(org, c, { criadaHa: "8 days" });

    expect(await reabrirLeituraAdiada(pool, org, { limite: 100, maxIdadeDias: 7 })).toBe(1);
    expect((await linha(recente)).media_derived_status).toBeNull();
    expect((await linha(velha)).metadata.derivacao_adiada, "a de 8 dias pagaria visão que ninguém lê").toBe("sem_leitor");
    expect(await eventosDeDerivacao(velha)).toHaveLength(0);

    // A válvula `always` (sem janela) alcança a velha.
    expect(await reabrirLeituraAdiada(pool, org, { limite: 100 })).toBe(1);
    expect((await linha(velha)).media_derived_status).toBeNull();
  });

  it("a varredura do cron lista só empresa operante com foto reabrível", async () => {
    const ativa = await novaOrg();
    await fotoAdiada(ativa, await novaConversa(ativa));
    const parada = await novaOrg();
    await fotoAdiada(parada, await novaConversa(parada));
    await pool.query(
      `update organizations set status = 'suspended', suspended_kind = 'administrativa', suspended_at = now()
        where id = $1`,
      [parada],
    );
    const soZerada = await novaOrg();
    await fotoAdiada(soZerada, await novaConversa(soZerada), { path: null });

    const lista = await organizacoesComLeituraAdiada(pool);
    expect(lista).toContain(ativa);
    expect(lista).not.toContain(parada);
    expect(lista).not.toContain(soZerada);
  });
});

describe("(d) o índice parcial", () => {
  it("idx_messages_derivacao_adiada existe", () => {
    expect(indexExists("idx_messages_derivacao_adiada")).toBe(true);
  });
});

describe("(e) o dreno de verdade", () => {
  it("foto antiga adiada: o turno reabre, pede a descrição e ADIA — a âncora é o pedido", async () => {
    const org = await novaOrg();
    const c = await novaConversa(org);
    await novoAgente(org, { publicadoNa: c.session });
    const foto = await fotoAdiada(org, c, { criadaHa: "3 days" });
    const texto = randomUUID();
    await pool.query(
      `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
                             type, direction, status, body, sent_via, sent_at)
       values ($1, $2, $3, $4, $5, 'text', 'inbound', 'delivered', 'é isso aqui', 'external_device', now())`,
      [texto, org, c.conv, c.session, c.contact],
    );
    const { rows } = await pool.query<{ id: string }>(
      `insert into event_log (organization_id, event_type, entity_kind, entity_id, payload, status)
       values ($1::uuid, 'ai_agent.dispatch_requested', 'message', $2::uuid,
               jsonb_build_object('organization_id', $1::text, 'conversation_id', $3::text,
                                  'contact_id', $4::text, 'channel_session_id', $5::text,
                                  'inbound_message_id', $2::text),
               'pending')
       returning id`,
      [org, texto, c.conv, c.contact, c.session],
    );

    await drainTick(
      pool,
      { batchSize: 20, intervalMs: 100, idleIntervalMs: 100, debounceMs: 0, reapTimeoutMs: 300_000 },
      log,
    );

    const reaberta = await linha(foto);
    expect(reaberta.media_derived_status).toBeNull();
    expect(reaberta.metadata).toHaveProperty("derivacao_pedida_em");
    expect(await eventosDeDerivacao(foto)).toHaveLength(1);
    const { rows: jobs } = await pool.query<{ n: number }>(
      `select count(*)::int as n from job_queue where source_event_id = $1`,
      [rows[0]!.id],
    );
    expect(jobs[0]!.n, "o turno saiu sem esperar a descrição da foto de 3 dias atrás").toBe(0);
  });
});

describe("(e2) o dreno de verdade, agente que não vê imagens", () => {
  it("foto adiada na conversa do agente com a opção desligada: não reabre e o turno sai", async () => {
    const org = await novaOrg();
    const c = await novaConversa(org);
    await novoAgente(org, { publicadoNa: c.session, visao: false });
    const foto = await fotoAdiada(org, c, { criadaHa: "1 minute" });
    const texto = randomUUID();
    await pool.query(
      `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
                             type, direction, status, body, sent_via, sent_at)
       values ($1, $2, $3, $4, $5, 'text', 'inbound', 'delivered', 'é isso aqui', 'external_device', now())`,
      [texto, org, c.conv, c.session, c.contact],
    );
    const { rows } = await pool.query<{ id: string }>(
      `insert into event_log (organization_id, event_type, entity_kind, entity_id, payload, status)
       values ($1::uuid, 'ai_agent.dispatch_requested', 'message', $2::uuid,
               jsonb_build_object('organization_id', $1::text, 'conversation_id', $3::text,
                                  'contact_id', $4::text, 'channel_session_id', $5::text,
                                  'inbound_message_id', $2::text),
               'pending')
       returning id`,
      [org, texto, c.conv, c.contact, c.session],
    );

    await drainTick(
      pool,
      { batchSize: 20, intervalMs: 100, idleIntervalMs: 100, debounceMs: 0, reapTimeoutMs: 300_000 },
      log,
    );

    expect((await linha(foto)).metadata.derivacao_adiada, "pediu visão para quem não vê").toBe("sem_leitor");
    expect(await eventosDeDerivacao(foto)).toHaveLength(0);
    const { rows: jobs } = await pool.query<{ n: number }>(
      `select count(*)::int as n from job_queue where source_event_id = $1`,
      [rows[0]!.id],
    );
    expect(jobs[0]!.n, "o turno ficou esperando uma foto que ele não vai ver").toBe(1);
  });
});

/** Texto do cliente + o evento do turno, e uma rodada do dreno de verdade. Devolve quantos jobs saíram. */
async function turnoDoDreno(org: string, c: Conversa): Promise<number> {
  const texto = randomUUID();
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
                           type, direction, status, body, sent_via, sent_at)
     values ($1, $2, $3, $4, $5, 'text', 'inbound', 'delivered', 'já paguei e vocês estão me cobrando',
             'external_device', now())`,
    [texto, org, c.conv, c.session, c.contact],
  );
  const { rows } = await pool.query<{ id: string }>(
    `insert into event_log (organization_id, event_type, entity_kind, entity_id, payload, status)
     values ($1::uuid, 'ai_agent.dispatch_requested', 'message', $2::uuid,
             jsonb_build_object('organization_id', $1::text, 'conversation_id', $3::text,
                                'contact_id', $4::text, 'channel_session_id', $5::text,
                                'inbound_message_id', $2::text),
             'pending')
     returning id`,
    [org, texto, c.conv, c.contact, c.session],
  );
  await drainTick(
    pool,
    { batchSize: 20, intervalMs: 100, idleIntervalMs: 100, debounceMs: 0, reapTimeoutMs: 300_000 },
    log,
  );
  const { rows: jobs } = await pool.query<{ n: number }>(
    `select count(*)::int as n from job_queue where source_event_id = $1`,
    [rows[0]!.id],
  );
  return jobs[0]!.n;
}

/** Roteador ativo na sessão, com estes membros. */
async function roteador(org: string, session: string, membros: string[]): Promise<void> {
  const router = randomUUID();
  await pool.query(
    `insert into ai_routers (id, organization_id, name, channel_session_id, is_active)
     values ($1, $2, 'Roteador', $3, true)`,
    [router, org, session],
  );
  for (const [i, agente] of membros.entries()) {
    await pool.query(
      `insert into ai_router_members (organization_id, router_id, agent_id, intent_name, intent_description)
       values ($1, $2, $3, $4, 'assunto')`,
      [org, router, agente, `assunto-${i}`],
    );
  }
}

describe("(e3) o dreno de verdade, quem responde pode não ser o agente da sessão", () => {
  // O agente da sessão (a Recepção) desligou a opção, e o roteador do número pode
  // entregar o turno ao Financeiro, que vê. O dreno resolve a Recepção; quem
  // responde é escolhido depois (`resolveTurnAgent`). Sem a régua da empresa, o
  // Financeiro lia `[image]` + "já paguei", sem o comprovante.
  it("agente da sessão desligado e membro do roteador ligado: reabre a foto e ADIA o turno", async () => {
    const org = await novaOrg();
    const c = await novaConversa(org);
    await novoAgente(org, { publicadoNa: c.session, visao: false });
    const longe = await novaConversa(org);
    await roteador(org, c.session, [await novoAgente(org, { publicadoNa: longe.session, visao: true })]);
    const foto = await fotoAdiada(org, c, { criadaHa: "1 minute" });

    const jobs = await turnoDoDreno(org, c);

    expect(await eventosDeDerivacao(foto), "o agente que vê, escolhido depois, ficou sem a descrição").toHaveLength(1);
    expect(jobs, "o turno saiu antes da descrição do comprovante").toBe(0);
  });

  it("número só com roteador e todos os membros desligados: não reabre e o turno sai", async () => {
    const org = await novaOrg();
    const c = await novaConversa(org);
    const longe = await novaConversa(org);
    await roteador(org, c.session, [
      await novoAgente(org, { publicadoNa: longe.session, visao: false }),
      await novoAgente(org, { publicadoNa: longe.session, visao: false }),
    ]);
    const foto = await fotoAdiada(org, c, { criadaHa: "1 minute" });

    const jobs = await turnoDoDreno(org, c);

    expect(await eventosDeDerivacao(foto), "pagou visão sem ninguém que a leia").toHaveLength(0);
    expect((await linha(foto)).metadata.derivacao_adiada).toBe("sem_leitor");
    expect(jobs, "o turno ficou esperando uma foto que ninguém vai ver").toBe(1);
  });
});

describe("(f) âncora forjada não cala a IA", () => {
  // `POST /api/v1/messages` já tira a chave do metadata do cliente; esta é a
  // segunda camada, para qualquer escritor que escape da primeira.
  it.each([
    ["texto que o Postgres não converte", "lixo"],
    ["data que não existe no calendário", "2026-02-31T10:00:00+00:00"],
    ["29 de fevereiro de ano não bissexto", "2027-02-29T10:00:00+00:00"],
    ["infinity", "infinity"],
    ["data futura", new Date(Date.now() + 365 * 86_400_000).toISOString()],
  ])("%s: o turno da conversa sai (a âncora cai na chegada)", async (_rotulo, ancora) => {
    const org = await novaOrg();
    const c = await novaConversa(org);
    await novoAgente(org, { publicadoNa: c.session });
    // Foto enviada pela integração há 3 dias, nunca derivada (status nulo), com a
    // âncora forjada: sem a guarda, ou a consulta cai no cast, ou a idade fica
    // negativa e o turno espera para sempre.
    await pool.query(
      `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id, type,
                             direction, status, body, sent_via, sent_at, created_at, media_url, media_mime,
                             metadata)
       values ($1, $2, $3, $4, $5, 'image', 'outbound', 'sent', null, 'system',
               now() - interval '3 days', now() - interval '3 days', 'https://cdn.exemplo/x.jpg', 'image/jpeg',
               jsonb_build_object('derivacao_pedida_em', $6::text))`,
      [randomUUID(), org, c.conv, c.session, c.contact, ancora],
    );
    const texto = randomUUID();
    await pool.query(
      `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
                             type, direction, status, body, sent_via, sent_at)
       values ($1, $2, $3, $4, $5, 'text', 'inbound', 'delivered', 'oi', 'external_device', now())`,
      [texto, org, c.conv, c.session, c.contact],
    );
    const { rows } = await pool.query<{ id: string }>(
      `insert into event_log (organization_id, event_type, entity_kind, entity_id, payload, status)
       values ($1::uuid, 'ai_agent.dispatch_requested', 'message', $2::uuid,
               jsonb_build_object('organization_id', $1::text, 'conversation_id', $3::text,
                                  'contact_id', $4::text, 'channel_session_id', $5::text,
                                  'inbound_message_id', $2::text),
               'pending')
       returning id`,
      [org, texto, c.conv, c.contact, c.session],
    );

    await drainTick(
      pool,
      { batchSize: 20, intervalMs: 100, idleIntervalMs: 100, debounceMs: 0, reapTimeoutMs: 300_000 },
      log,
    );

    const { rows: jobs } = await pool.query<{ n: number }>(
      `select count(*)::int as n from job_queue where source_event_id = $1`,
      [rows[0]!.id],
    );
    expect(jobs[0]!.n, "a âncora forjada segurou ou derrubou o turno").toBe(1);
  });
});

describe("(g) o padrão da âncora no motor do Postgres", () => {
  it("casa o que jsonb_build_object(now()) grava, em qualquer fuso", async () => {
    const cliente = await pool.connect();
    try {
      for (const fuso of ["UTC", "America/Sao_Paulo", "Asia/Kolkata", "Pacific/Chatham", "Pacific/Kiritimati"]) {
        await cliente.query(`select set_config('TimeZone', $1, false)`, [fuso]);
        const { rows } = await cliente.query<{ ancora: string; casa: boolean }>(
          `select a as ancora, a ~ $1 as casa
             from (select jsonb_build_object('k', now()) ->> 'k' as a) x`,
          [ANCORA_ISO_8601],
        );
        expect(rows[0]!.casa, `${fuso}: ${rows[0]!.ancora}`).toBe(true);
      }
    } finally {
      await cliente.query(`reset timezone`);
      cliente.release();
    }
  });

  it("tudo o que casa converte sem erro; o que não existe no calendário não casa", async () => {
    const amostra = [
      "2026-10-31T18:01:00.123456+00:00",
      "2026-10-31T18:01:00Z",
      "2028-02-29T00:00:00-03:00",
      "2000-02-29T23:59:59.999999+14:00",
      "2099-12-31T23:59:59-14:59",
      "2026-01-31T00:00:00+00:00",
      "2026-04-30T00:00:00+00:00",
      "2026-02-28T00:00:00+00:00",
      "2026-02-29T00:00:00+00:00",
      "2026-02-30T00:00:00+00:00",
      "2026-04-31T00:00:00+00:00",
      "2100-02-29T00:00:00+00:00",
      "infinity",
      "lixo",
    ];
    const { rows } = await pool.query<{ texto: string; casa: boolean }>(
      `select t as texto, t ~ $2 as casa from unnest($1::text[]) with ordinality u(t, i) order by i`,
      [amostra, ANCORA_ISO_8601],
    );
    const casam = rows.filter((r) => r.casa).map((r) => r.texto);
    expect(casam).toEqual(amostra.slice(0, 8));
    // Cada um que casa tem de converter: é a garantia que o cast do dreno usa.
    await pool.query(`select t::timestamptz from unnest($1::text[]) t`, [casam]);
  });
});
