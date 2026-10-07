import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { ORIGEM_DO_WHATSAPP, origemDoNegocioPeloCanal } from "@/lib/channels/origem-do-negocio";
import { DICIONARIO } from "@/lib/i18n/dicionario";
import { SOCIAL_NETWORKS } from "@/lib/channels/social/catalog";
import type { SocialMessage } from "@/lib/channels/social/parser";

/**
 * O NEGÓCIO DIZ POR ONDE O CLIENTE CHEGOU.
 *
 * Medido numa VPS em 2026-10-03: uma mensagem no direct do Instagram abriu a
 * conversa certa (`channel = 'instagram'`), mas o negócio nasceu com
 * `source = 'whatsapp'` e a linha do tempo dizia "Entrou pelo WhatsApp /
 * primeira mensagem recebida no WhatsApp". `garantirLeadDaConversa` assume
 * WhatsApp quando ninguém diz o canal — e a ingestão compartilhada nunca dizia.
 *
 * Três camadas, uma por `describe`: a tradução canal → origem, a ingestão
 * compartilhada que a repassa, e a ingestão das redes sociais que informa o
 * canal. Qualquer uma que falhe volta a gravar WhatsApp.
 */

describe("a origem do negócio sai do canal da conversa", () => {
  it("sem canal, é WhatsApp — o caminho do QR e do número oficial", () => {
    expect(origemDoNegocioPeloCanal(undefined)).toEqual({
      rotulo: "WhatsApp",
      source: "whatsapp",
      motivo: "primeira mensagem recebida no WhatsApp",
    });
    expect(origemDoNegocioPeloCanal("whatsapp").source).toBe("whatsapp");
  });

  it("Instagram é Instagram", () => {
    expect(origemDoNegocioPeloCanal("instagram")).toEqual({
      rotulo: "Instagram",
      source: "instagram",
      motivo: "primeira mensagem recebida no Instagram",
    });
  });

  it("toda rede que recebe mensagem tem a SUA origem — inclusive as que entrarem depois", () => {
    // Derivado do catálogo: marcar `inbox: true` numa rede nova tem que bastar.
    const comAtendimento = SOCIAL_NETWORKS.filter((r) => r.inbox);
    expect(comAtendimento.length).toBeGreaterThan(0);
    for (const rede of comAtendimento) {
      const origem = origemDoNegocioPeloCanal(rede.id);
      expect(origem.source, rede.id).toBe(rede.id);
      expect(origem.motivo, rede.id).toContain(rede.label);
      expect(origem.motivo, rede.id).not.toContain("WhatsApp");
    }
  });

  it("rede sem atendimento não inventa origem", () => {
    // Não chega mensagem dela (a ingestão recusa antes), mas se chegar, cai no
    // padrão em vez de gravar um `source` que nenhum relatório conhece.
    expect(origemDoNegocioPeloCanal("linkedin").source).toBe("whatsapp");
    expect(origemDoNegocioPeloCanal("rede-que-nao-existe").source).toBe("whatsapp");
  });
});

describe("o motivo do nascimento tem tradução", () => {
  // A linha do tempo mostra o motivo por `t(item.reason)` (LeadTimeline). Sem a
  // chave no dicionário, quem usa o CRM em espanhol ou inglês lê o motivo em
  // português. Os motivos saem do mesmo catálogo que o código usa, então uma
  // rede nova com atendimento reprova aqui até ganhar tradução.
  const en = JSON.parse(readFileSync("lib/i18n/traducoes/en.json", "utf8")) as Record<string, string>;
  const motivos = [
    ORIGEM_DO_WHATSAPP.motivo,
    ...SOCIAL_NETWORKS.filter((r) => r.inbox).map((r) => origemDoNegocioPeloCanal(r.id).motivo),
    // `workers/voice-agent/index.ts` e o cliente que volta (`nascimento-do-lead.ts`).
    "primeira ligação recebida",
    "cliente conhecido voltou a escrever",
  ];

  it.each(motivos)("%s — espanhol e inglês", (motivo) => {
    expect(DICIONARIO[motivo]?.es, `sem espanhol: ${motivo}`).toBeTruthy();
    expect(en[motivo], `sem inglês: ${motivo}`).toBeTruthy();
  });

  it("a origem padrão é UM objeto só — não uma segunda cópia do texto", () => {
    expect(origemDoNegocioPeloCanal(undefined)).toBe(ORIGEM_DO_WHATSAPP);
    const nascimento = readFileSync("lib/leads/nascimento-do-lead.ts", "utf8");
    expect(nascimento).toMatch(/const ORIGEM_PADRAO: OrigemDoNascimento = ORIGEM_DO_WHATSAPP;/);
    expect(nascimento).not.toMatch(/motivo: "primeira mensagem recebida no WhatsApp"/);
  });
});

// ─── A ingestão das redes sociais informa o canal ───────────────────────────

const aplicarEfeitosPosEntrada = vi.fn(async () => {});
vi.mock("@/lib/channels/pos-entrada", () => ({
  aplicarEfeitosPosEntrada: (...a: unknown[]) => aplicarEfeitosPosEntrada(...(a as [])),
}));
vi.mock("@/lib/channels/marcar-conversa", () => ({
  marcarConversaComMensagem: vi.fn(async () => {}),
}));
vi.mock("@/lib/leads/atribuicao-de-anuncio", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/leads/atribuicao-de-anuncio")>()),
  estamparAtribuicaoDoContato: vi.fn(async () => {}),
}));
vi.mock("@/lib/plataformas-de-anuncio/google/atribuicao", () => ({
  extrairEEstamparAtribuicaoGoogle: vi.fn(async () => {}),
}));
vi.mock("@/lib/escalacao/atendimento-manual", () => ({
  pausarIaPorAtendimentoManual: vi.fn(async () => {}),
}));

/** Conversa que a thread já tem — `null` leva ao caminho que cria. */
let conversaExistente: { id: string; contact_id: string } | null = null;

/** Imita o builder do PostgREST o bastante para o caminho das redes sociais. */
function chain(tabela: string, op: string): Record<string, unknown> {
  const proxy: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "maybeSingle" || prop === "single") {
          if (tabela === "conversations" && op === "select") {
            return async () => ({ data: conversaExistente, error: null });
          }
          if (tabela === "contacts" && op === "select")
            return async () => ({ data: null, error: null });
          if (tabela === "contacts" && op === "insert") {
            return async () => ({ data: { id: "contato-1" }, error: null });
          }
          return async () => ({ data: { id: "msg-1" }, error: null });
        }
        if (prop === "then") {
          return (ok: (v: unknown) => unknown) => ok({ data: [], error: null });
        }
        return () => proxy;
      },
    },
  ) as Record<string, unknown>;
  return proxy;
}

const admin = {
  rpc: async (nome: string) => ({
    data: nome === "fn_upsert_wa_conversation" ? "conv-1" : null,
    error: null,
  }),
  from: (tabela: string) => ({
    select: () => chain(tabela, "select"),
    insert: () => chain(tabela, "insert"),
    update: () => chain(tabela, "update"),
  }),
} as never;

function mensagemSocial(platform: string): SocialMessage {
  return {
    direction: "inbound",
    kind: "message",
    conversationId: "thread-1",
    externalId: `social:acc-1:${platform}-m1`,
    accountId: "acc-1",
    text: "Olá",
    attachments: [],
    sentAt: "2026-10-03T13:50:00.000Z",
    identity: {
      phone: null,
      bsuid: null,
      username: "cliente",
      displayName: "Cliente",
      anchor: null,
    },
    referral: null,
    platform,
    participantId: "participante-1",
  };
}

async function ingerir(platform: string) {
  const { ingestZernioInbound } = await import("@/lib/channels/zernio/ingest");
  return ingestZernioInbound(admin, {
    organizationId: "org-1",
    channelSessionId: "sess-1",
    payload: {},
    socialMessage: mensagemSocial(platform),
  });
}

function canalRepassado(): unknown {
  const chamadas = aplicarEfeitosPosEntrada.mock.calls as unknown as Array<
    [unknown, { canal?: unknown }]
  >;
  expect(chamadas).toHaveLength(1);
  return chamadas[0]![1].canal;
}

beforeEach(() => {
  conversaExistente = null;
  aplicarEfeitosPosEntrada.mockClear();
});

describe("a mensagem de rede social leva o canal até o nascimento do negócio", () => {
  it("conversa NOVA do Instagram: o canal é instagram", async () => {
    const r = await ingerir("instagram");
    expect(r.status).toBe("ingested");
    expect(canalRepassado()).toBe("instagram");
  });

  it("conversa que a thread JÁ tem: o mesmo canal — os dois ramos repassam", async () => {
    // São dois pontos de chamada. Consertar só o da conversa nova deixaria a
    // conversa reaberta (cujo negócio anterior fechou) nascendo como WhatsApp.
    conversaExistente = { id: "conv-existente", contact_id: "contato-1" };
    const r = await ingerir("instagram");
    expect(r.status).toBe("ingested");
    expect(canalRepassado()).toBe("instagram");
  });

  it("Facebook é Facebook", async () => {
    await ingerir("facebook");
    expect(canalRepassado()).toBe("facebook");
  });
});
