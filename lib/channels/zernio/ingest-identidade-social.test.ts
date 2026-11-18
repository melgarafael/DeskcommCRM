import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SocialMessage } from "@/lib/channels/social/parser";

/**
 * A DM DA REDE SOCIAL ACHA A FICHA PELA IDENTIDADE (#3764, fatia 1).
 *
 * Depois de uma fusão, a identidade da ficha absorvida mora em
 * `contact_identities` apontando para a vencedora — e o `social_identity` dela
 * ficou na lápide quando a vencedora já tinha o seu. A ingestão tem de
 * perguntar à tabela ANTES de cair na busca por `social_identity`; senão a
 * próxima conversa cria uma ficha nova. A parte do banco (a fusão repontando a
 * linha) é medida em `tests/invariants/identidades-do-contato.test.ts`.
 */

vi.mock("@/lib/channels/pos-entrada", () => ({ aplicarEfeitosPosEntrada: vi.fn(async () => {}) }));
vi.mock("@/lib/channels/marcar-conversa", () => ({ marcarConversaComMensagem: vi.fn(async () => {}) }));
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

/** O dono que `contact_identities` devolve; `null` = identidade inédita. */
let donoDaIdentidade: string | null = null;
let consultasDaIdentidade: Array<[string, unknown]> = [];
let identidadesGravadas: Record<string, unknown>[] = [];
let contatosCriados = 0;
let contatoDaConversa: unknown = null;

function chain(tabela: string, op: string, filtros: Array<[string, unknown]> = []): Record<string, unknown> {
  const proxy: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "maybeSingle" || prop === "single") {
          if (tabela === "contact_identities") {
            consultasDaIdentidade = filtros;
            return async () => ({
              data: donoDaIdentidade ? { contact_id: donoDaIdentidade, contacts: { id: donoDaIdentidade } } : null,
              error: null,
            });
          }
          if (tabela === "conversations") return async () => ({ data: null, error: null });
          if (tabela === "contacts" && op === "select") return async () => ({ data: null, error: null });
          if (tabela === "contacts" && op === "insert") {
            contatosCriados += 1;
            return async () => ({ data: { id: "ficha-nova" }, error: null });
          }
          return async () => ({ data: { id: "msg-1" }, error: null });
        }
        if (prop === "then") return (ok: (v: unknown) => unknown) => ok({ data: [], error: null });
        if (prop === "eq" || prop === "is") {
          return (coluna: string, valor: unknown) => {
            filtros.push([coluna, valor]);
            return proxy;
          };
        }
        return () => proxy;
      },
    },
  ) as Record<string, unknown>;
  return proxy;
}

const admin = {
  rpc: async (nome: string, args: Record<string, unknown>) => {
    if (nome === "fn_upsert_wa_conversation") {
      contatoDaConversa = args.p_contact;
      return { data: "conv-1", error: null };
    }
    return { data: null, error: null };
  },
  from: (tabela: string) => ({
    select: () => chain(tabela, "select"),
    insert: (linha: Record<string, unknown>) => {
      if (tabela === "contact_identities") identidadesGravadas.push(linha);
      return chain(tabela, "insert");
    },
    update: () => chain(tabela, "update"),
  }),
} as never;

function dm(platform: string, participantId: string): SocialMessage {
  return {
    direction: "inbound",
    kind: "message",
    conversationId: "thread-nova",
    externalId: `social:conta-1:${platform}-m1`,
    accountId: "conta-1",
    text: "Oi de novo",
    attachments: [],
    sentAt: "2026-11-17T13:00:00.000Z",
    identity: { phone: null, bsuid: null, username: null, displayName: "Cliente", anchor: null },
    referral: null,
    platform,
    participantId,
  };
}

async function ingerir(social: SocialMessage) {
  const { ingestZernioInbound } = await import("@/lib/channels/zernio/ingest");
  return ingestZernioInbound(admin, {
    organizationId: "org-1",
    channelSessionId: "sess-1",
    payload: {},
    socialMessage: social,
  });
}

beforeEach(() => {
  donoDaIdentidade = null;
  consultasDaIdentidade = [];
  identidadesGravadas = [];
  contatosCriados = 0;
  contatoDaConversa = null;
});

describe("a ingestão das redes sociais lê e grava contact_identities", () => {
  it("identidade que já é de uma ficha (a vencedora de uma fusão): a conversa nasce nela, sem ficha nova", async () => {
    donoDaIdentidade = "ficha-vencedora";
    const r = await ingerir(dm("facebook", "1000000000000302"));
    expect(r.status).toBe("ingested");
    expect(contatoDaConversa).toBe("ficha-vencedora");
    expect(contatosCriados).toBe(0);
    expect(identidadesGravadas).toEqual([]);
    // A busca é da organização, da rede e do id normalizado, e ignora ficha mesclada.
    expect(consultasDaIdentidade).toEqual([
      ["organization_id", "org-1"],
      ["canal", "facebook"],
      ["identificador", "1000000000000302"],
      ["contacts.is_merged_into", null],
    ]);
  });

  it("identidade inédita: a ficha nasce e a identidade é gravada nela", async () => {
    const r = await ingerir(dm("instagram", "17841400000000301"));
    expect(r.status).toBe("ingested");
    expect(contatoDaConversa).toBe("ficha-nova");
    expect(contatosCriados).toBe(1);
    expect(identidadesGravadas).toEqual([
      {
        organization_id: "org-1",
        contact_id: "ficha-nova",
        canal: "instagram",
        identificador: "17841400000000301",
      },
    ]);
  });

  it("rede fora de contact_identities.canal não consulta nem grava a tabela", async () => {
    // Sem canal de conversa no banco a ingestão para depois de achar a ficha;
    // o que importa aqui é que a ficha foi resolvida sem tocar a tabela.
    await ingerir(dm("tiktok", "1234567890"));
    expect(contatosCriados).toBe(1);
    expect(consultasDaIdentidade).toEqual([]);
    expect(identidadesGravadas).toEqual([]);
  });
});
