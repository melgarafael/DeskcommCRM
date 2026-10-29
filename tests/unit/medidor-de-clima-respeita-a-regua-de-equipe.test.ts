/**
 * O MEDIDOR DE CLIMA E O TURNO LEEM A MESMA RÉGUA DE "QUEM É EQUIPE" (#3534).
 *
 * ─── O que este arquivo prende ──────────────────────────────────────────────
 *
 * 1. A régua é UMA: `contacts.tags` × `organizations.settings.crm.internal_contact_tags`
 *    (`lib/contacts/tags-internas.ts`, #2353) entra em `decidirElegibilidade` por
 *    `montarEstadoDeElegibilidade`, e os DOIS transportes a leem — o do turno e do
 *    dreno (`consulta-pg.ts`, pool `pg`) e o do medidor de clima
 *    (`consulta-supabase.ts`, supabase-js).
 * 2. Comportamentalmente, o telefone marcado como equipe NÃO cai como cliente: o
 *    worker de sentimento para antes de pagar o modelo e não emite
 *    `ai.sentiment_alert` (que viraria `triggerHandoff('low_sentiment')`).
 * 3. O CONTROLE: um telefone fora da equipe, na MESMA organização, no MESMO
 *    texto, continua sendo medido e chamando uma pessoa. Sem ele, "não mede" se
 *    provaria com um worker que não mede ninguém.
 *
 * ─── Por que o caso de hoje é frágil ────────────────────────────────────────
 *
 * A paridade depende de um campo por transporte: `ct.tags as contact_tags` no
 * SQL (`consulta-pg.ts:49`) e `tags` na lista de colunas do `select`
 * (`consulta-supabase.ts:59`). Apagar qualquer um dos dois não quebra teste
 * nenhum — o embed simplesmente deixa de trazer a coluna, `contactTags` vira
 * `null`, `ehContatoInterno` devolve `false`, e o medidor volta a tratar o sócio
 * como cliente irritado: exatamente o caso relatado no #3534 (repasse por
 * `low_sentiment` e `bot_silenced_until = infinity`).
 *
 * ─── SABOTAGEM (previsto antes de rodar) ────────────────────────────────────
 *
 * - Tirar `tags` do `select` de `consulta-supabase.ts:59` → o caso da equipe
 *   passa a ser medido e emite alerta: o primeiro caso fica VERMELHO.
 * - Tirar `contactTags: row.contacts?.tags` de `consulta-supabase.ts:80` → o
 *   mesmo caso fica VERMELHO (e o de paridade, também).
 * - Tirar `ct.tags as contact_tags` / `contactTags: r.contact_tags` de
 *   `consulta-pg.ts` → o caso de paridade fica VERMELHO; o comportamental NÃO
 *   (ele exercita o transporte do medidor), que é justamente por que os dois
 *   existem.
 * - Apagar o veto `contato_interno` de `lib/ai/elegibilidade/gate.ts:172` → o
 *   caso da equipe fica VERMELHO.
 */
import fs from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const envMock: Record<string, string> = {
  ANTHROPIC_API_KEY: "sk-ant-teste",
  AI_GATEWAY_API_KEY: "",
  OPENROUTER_API_KEY: "",
  OPENAI_API_KEY: "",
};
vi.mock("@/lib/env", () => ({
  get env() {
    return envMock;
  },
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/ai/log-invocation", () => ({ logInvocation: vi.fn() }));
vi.mock("@/lib/ai/cost", () => ({ computeCost: vi.fn(async () => 1) }));
vi.mock("@/lib/ai/gateway-binding", () => ({ resolverModeloDoPonto: vi.fn() }));
vi.mock("ai", () => ({ generateObject: vi.fn() }));

import { generateObject } from "ai";

import { resolverModeloDoPonto } from "@/lib/ai/gateway-binding";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { createAdminClient } from "@/lib/supabase/admin";
import { processSentiment } from "@/workers/ai-sentiment-worker";

const RAIZ = process.cwd();
const fonte = (...partes: string[]) => fs.readFileSync(path.join(RAIZ, ...partes), "utf8");
const semComentarios = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const ORG = "11111111-1111-4111-8111-111111111111";
const SESSAO = "44444444-4444-4444-8444-444444444444";
const AGENTE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VERSAO = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CONTATO = "55555555-5555-4555-8555-555555555555";

/** O texto do relato: um sócio cobrando o agente pelos áudios que não foram respondidos. */
const TEXTO_DO_SOCIO = "por que você não respondeu meus áudios? E se fosse um cliente? Eu iria ficar sem resposta?";
/** Abaixo do limiar padrão (0,3): numa conversa elegível, o alerta sai. */
const NOTA_IRRITADA = 0.1;

type Linha = Record<string, unknown>;

/**
 * Mini-banco: aplica `eq`/`is`, e devolve a linha única ou a lista. As tabelas
 * embutidas na conversa (`contacts`, `organizations`, `channel_sessions`) são o
 * que a régua de elegibilidade lê no transporte supabase-js.
 */
function fazerAdmin(banco: Record<string, Linha[]>, rpcs: Linha[]) {
  const from = (tabela: string) => {
    const filtros: Array<(l: Linha) => boolean> = [];
    const linhas = () => (banco[tabela] ?? []).filter((l) => filtros.every((f) => f(l)));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = new Proxy(
      {},
      {
        get: (_alvo, prop: string) => {
          if (prop === "maybeSingle" || prop === "single") {
            return () => Promise.resolve({ data: linhas()[0] ?? null, error: null });
          }
          if (prop === "then") {
            return (ok: (v: unknown) => unknown, falha?: (e: unknown) => unknown) =>
              Promise.resolve({ data: linhas(), error: null }).then(ok, falha);
          }
          return (...args: unknown[]) => {
            if (prop === "eq") filtros.push((l) => l[args[0] as string] === args[1]);
            if (prop === "is") filtros.push((l) => (l[args[0] as string] ?? null) === args[1]);
            return chain;
          };
        },
      },
    );
    return chain;
  };
  return {
    from,
    rpc: (nome: string, args: Linha) => {
      rpcs.push({ nome, ...args });
      return Promise.resolve({ data: null, error: null });
    },
  };
}

/**
 * O mesmo cenário com um telefone só: a ÚNICA coisa que muda entre os dois
 * casos do teste é a etiqueta do contato — mesmo texto, mesma organização,
 * mesma lista interna na organização, mesma versão publicada.
 */
function cenario(tagsDoContato: string[], listaDaOrg: string[]) {
  const msg = "22222222-2222-4222-8222-222222222222";
  const conv = "33333333-3333-4333-8333-333333333333";
  const settings = { crm: { internal_contact_tags: listaDaOrg } };
  const banco: Record<string, Linha[]> = {
    organizations: [{ id: ORG, settings, locale: "pt-BR" }],
    messages: [
      {
        id: msg,
        organization_id: ORG,
        conversation_id: conv,
        body: TEXTO_DO_SOCIO,
        direction: "inbound",
        metadata: {},
      },
    ],
    conversations: [
      {
        id: conv,
        organization_id: ORG,
        channel_session_id: SESSAO,
        active_ai_agent_id: null,
        contact_id: CONTATO,
        is_group: false,
        assignee_kind: "ai",
        bot_silenced_until: null,
        organizations: { status: "active", settings },
        contacts: {
          force_human: false,
          ai_opt_out: false,
          ai_authorized_at: null,
          phone_number: "+5511988887777",
          tags: tagsDoContato,
        },
        channel_sessions: { metadata: {} },
      },
    ],
    ai_agents: [
      {
        id: AGENTE,
        organization_id: ORG,
        config: {},
        kind: "mcp_agent",
        is_active: true,
        priority: 0,
        created_at: "2026-01-01T00:00:00.000Z",
        published_version_id: VERSAO,
        archived_at: null,
        paused_at: null,
      },
    ],
    ai_agent_versions: [
      { id: VERSAO, organization_id: ORG, agent_id: AGENTE, channel_session_id: SESSAO, status: "published" },
    ],
  };
  const evento = {
    id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    organization_id: ORG,
    entity_id: msg,
    payload: { message_id: msg, conversation_id: conv },
  } as unknown as EventRow;
  return { banco, evento };
}

async function medir(tagsDoContato: string[], listaDaOrg: string[]) {
  const { banco, evento } = cenario(tagsDoContato, listaDaOrg);
  const rpcs: Linha[] = [];
  vi.mocked(createAdminClient).mockReturnValue(
    fazerAdmin(banco, rpcs) as unknown as ReturnType<typeof createAdminClient>,
  );
  const resultado = await processSentiment(evento);
  return { resultado, alertas: rpcs.filter((r) => r["p_event_type"] === "ai.sentiment_alert") };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolverModeloDoPonto).mockResolvedValue({
    model: "modelo-dublê",
    modelId: "anthropic/claude-haiku-4-5",
  } as unknown as Awaited<ReturnType<typeof resolverModeloDoPonto>>);
  vi.mocked(generateObject).mockResolvedValue({
    object: { sentiment_score: NOTA_IRRITADA, reasoning_short: "irritado com o atendimento" },
    usage: { inputTokens: 10, outputTokens: 5 },
  } as unknown as Awaited<ReturnType<typeof generateObject>>);
});

describe("medidor de clima × régua de equipe (#3534)", () => {
  it("telefone da equipe não cai como cliente — nem paga o modelo, nem chama uma pessoa", async () => {
    const r = await medir(["equipe"], ["equipe"]);

    expect(r.resultado).toEqual({ skipped: true, reason: "nao_elegivel_para_ia:contato_interno" });
    expect(generateObject, "pagou o modelo para um alerta que o handoff recusaria").not.toHaveBeenCalled();
    expect(r.alertas, "o sócio foi passado a uma pessoa e o agente calado (low_sentiment)").toHaveLength(0);
  });

  it("CONTROLE: telefone fora da equipe, no mesmo cenário, continua sendo medido", async () => {
    const r = await medir([], ["equipe"]);

    expect(r.resultado).toMatchObject({ skipped: false, sentiment_score: NOTA_IRRITADA });
    expect(generateObject).toHaveBeenCalledTimes(1);
    expect(r.alertas, "o cliente irritado deixou de chamar uma pessoa").toHaveLength(1);
  });

  it("a régua é a mesma do turno: os dois transportes leem `contacts.tags` e entregam `contactTags`", () => {
    // Turno e dreno (pool `pg`).
    const pg = semComentarios(fonte("lib", "ai", "elegibilidade", "consulta-pg.ts"));
    expect(pg, "o SQL do turno deixou de trazer a etiqueta interna").toMatch(
      /ct\.tags\s+as contact_tags/,
    );
    expect(pg).toMatch(/contactTags:\s*r\.contact_tags/);

    // Medidor de clima (supabase-js).
    const sb = semComentarios(fonte("lib", "ai", "elegibilidade", "consulta-supabase.ts"));
    expect(sb, "o embed do contato deixou de trazer a etiqueta interna").toMatch(
      /contacts:contact_id\([^)]*\btags\b/,
    );
    expect(sb).toMatch(/contactTags:\s*row\.contacts\?\.tags/);

    // E os dois chegam na MESMA regra: a lista da organização entra ao lado da
    // etiqueta do contato, e o veto é um só.
    const gate = semComentarios(fonte("lib", "ai", "elegibilidade", "gate.ts"));
    expect(gate).toMatch(
      /contatoInterno:\s*ehContatoInterno\(raw\.contactTags,\s*tagsInternasDaOrg\(raw\.orgSettings\)\)/,
    );
    expect(gate).toMatch(/if \(e\.contatoInterno\)/);
    expect(gate).toMatch(/motivo:\s*"contato_interno"/);
  });
});
