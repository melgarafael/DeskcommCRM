import { createHmac } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Coexistência: o que a empresa faz no ENDEREÇO do app WhatsApp Business chega
 * ao CRM. A Meta entrega no campo `smb_app_state_sync`, que o parser descartava
 * — o CRM ficava sem o nome que a equipe usa no celular. O formato do payload é
 * o da referência da Meta (webhooks/reference/smb_app_state_sync).
 *
 * As quatro coisas que este arquivo prova:
 *
 *   1. o payload vira evento (`smb_app_state_sync` → `app_contact_sync`);
 *   2. o evento vira CONTATO com o nome do app — e nada mais: nenhuma escrita em
 *      `messages`/`conversations`, nenhuma pausa de IA, nenhuma marcação de
 *      conversa (o `admin.from` de mentira em explodir em qualquer tabela que
 *      não seja `channel_sessions` é justamente essa prova);
 *   3. `remove`/payload sem nome não escreve nada (`ignored: sem_nome`);
 *   4. sync de OUTRO número não vaza: sessão que não é dona do `phone_number_id`
 *      devolve `no_session` sem uma única escrita.
 */

const estado = vi.hoisted(() => ({
  rpcs: [] as Array<{ name: string; args: Record<string, unknown> }>,
  /** `null` = o número do payload não é desta organização (outro número). */
  sessao: { id: "session-1", organization_id: "org-1" } as {
    id: string;
    organization_id: string;
  } | null,
  contatoExistente: null as { id: string; phone_number: string } | null,
  numeroInterno: false,
  erroContato: null as { code: string; message: string } | null,
  marcacoes: [] as Array<Record<string, unknown>>,
  pausas: [] as Array<Record<string, unknown>>,
  auditorias: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/channels/contato-por-telefone", () => ({
  encontrarContatoPorTelefone: async () => estado.contatoExistente,
}));
vi.mock("@/lib/escalacao/numero-interno-de-aviso", () => ({
  ehNumeroInternoDeAviso: async () => estado.numeroInterno,
  registrarMensagemIgnorada: async () => undefined,
}));
vi.mock("@/lib/channels/marcar-conversa", () => ({
  marcarConversaComMensagem: async (_a: unknown, args: Record<string, unknown>) => {
    estado.marcacoes.push(args);
  },
}));
vi.mock("@/lib/escalacao/atendimento-manual", () => ({
  pausarIaPorAtendimentoManual: async (_a: unknown, input: Record<string, unknown>) => {
    estado.pausas.push(input);
    return true;
  },
}));
vi.mock("@/lib/audit", () => ({
  audit: async (entrada: Record<string, unknown>) => {
    estado.auditorias.push(entrada);
  },
}));

import { ingestMetaAppContactSync } from "@/lib/channels/meta/ingest";
import { parseMetaWebhook, type AppContactSyncEvent } from "@/lib/channels/meta/webhook";

function envelopeDeSync(syncs: unknown[], phoneNumberId = "phone-1") {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-1",
        changes: [
          {
            field: "smb_app_state_sync",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "5511300000000", phone_number_id: phoneNumberId },
              state_sync: syncs,
            },
          },
        ],
      },
    ],
  };
}

/**
 * Admin de mentira: qualquer tabela que NÃO seja `channel_sessions` explode.
 * Uma gravação de mensagem, de conversa ou de contato direto derruba o teste —
 * é assim que "não toca em nada além do cadastro" é provado, e não declarado.
 */
function adminFalso(): SupabaseClient {
  const from = (table: string) => {
    if (table === "channel_sessions") {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        is: () => chain,
        maybeSingle: async () => ({ data: estado.sessao, error: null }),
      };
      return chain;
    }
    throw new Error(`tabela inesperada: ${table}`);
  };
  const rpc = async (name: string, args: Record<string, unknown>) => {
    estado.rpcs.push({ name, args });
    if (name === "fn_upsert_wa_contact") {
      return estado.erroContato
        ? { data: null, error: estado.erroContato }
        : { data: "contact-1", error: null };
    }
    return { data: null, error: null };
  };
  return { from, rpc } as unknown as SupabaseClient;
}

const CONTATO_DO_APP: AppContactSyncEvent = {
  kind: "app_contact_sync",
  wabaId: "waba-1",
  phoneNumberId: "phone-1",
  phone: "5519999999999",
  name: "Ana Souza",
  action: "add",
};

beforeEach(() => {
  estado.rpcs = [];
  estado.sessao = { id: "session-1", organization_id: "org-1" };
  estado.contatoExistente = null;
  estado.numeroInterno = false;
  estado.erroContato = null;
  estado.marcacoes = [];
  estado.pausas = [];
  estado.auditorias = [];
});

describe("parser: smb_app_state_sync vira evento de contato", () => {
  it("contato com nome completo vira `app_contact_sync` com o número e o dono do endereço", () => {
    const eventos = parseMetaWebhook(
      envelopeDeSync([
        {
          type: "contact",
          contact: { full_name: "Ana Souza", first_name: "Ana", phone_number: "5519999999999" },
          action: "add",
          metadata: { timestamp: "1739321024" },
        },
      ]) as Parameters<typeof parseMetaWebhook>[0],
    );

    expect(eventos).toEqual([
      {
        kind: "app_contact_sync",
        wabaId: "waba-1",
        phoneNumberId: "phone-1",
        phone: "5519999999999",
        name: "Ana Souza",
        action: "add",
      },
    ]);
  });

  it("sem `full_name` cai para `first_name`; `remove` vem sem nome", () => {
    const eventos = parseMetaWebhook(
      envelopeDeSync([
        { type: "contact", contact: { first_name: "Ana", phone_number: "5511988887777" }, action: "add" },
        { type: "contact", contact: { phone_number: "5511977776666" }, action: "remove" },
      ]) as Parameters<typeof parseMetaWebhook>[0],
    );

    expect(eventos).toMatchObject([
      { name: "Ana", action: "add", phone: "5511988887777" },
      { name: null, action: "remove", phone: "5511977776666" },
    ]);
  });

  it("sem `phone_number`, com outro `type` ou noutro `field` nada vira evento", () => {
    const semNumero = parseMetaWebhook(
      envelopeDeSync([{ type: "contact", contact: { full_name: "Ana" }, action: "add" }]) as Parameters<
        typeof parseMetaWebhook
      >[0],
    );
    const outroTipo = parseMetaWebhook(
      envelopeDeSync([{ type: "group", contact: { full_name: "Ana", phone_number: "5511999998888" } }]) as Parameters<
        typeof parseMetaWebhook
      >[0],
    );
    // Um `field` que não tratamos (a #1632 fala em `history`; essa parte ficou
    // fora de escopo) continua caindo fora de propósito, como todo evento
    // desconhecido — recusar viraria re-entrega em loop.
    const outroField = {
      object: "whatsapp_business_account",
      entry: [{ id: "waba-1", changes: [{ field: "history", value: { history: [{ id: "wamid.X" }] } }] }],
    };

    expect(semNumero).toEqual([]);
    expect(outroTipo).toEqual([]);
    expect(parseMetaWebhook(outroField as Parameters<typeof parseMetaWebhook>[0])).toEqual([]);
  });
});

describe("ingestão do contato do app", () => {
  it("grava o contato com o nome do celular e NÃO toca em mensagem, conversa ou IA", async () => {
    const r = await ingestMetaAppContactSync(adminFalso(), CONTATO_DO_APP, { organizationId: "org-1" });

    expect(r).toEqual({ status: "synced", contactId: "contact-1" });
    expect(estado.rpcs).toHaveLength(1);
    expect(estado.rpcs[0]?.name).toBe("fn_upsert_wa_contact");
    expect(estado.rpcs[0]?.args).toMatchObject({
      p_org: "org-1",
      p_kind: "phone",
      p_chat_id: "5519999999999",
      p_notify: "Ana Souza",
    });
    expect(estado.rpcs[0]?.args.p_phone).toContain("5519999999999");
    // Nada de caixa de entrada nem de agente: ninguém trocou mensagem.
    expect(estado.marcacoes).toEqual([]);
    expect(estado.pausas).toEqual([]);
    expect(estado.auditorias).toEqual([]);
  });

  it("reaproveita o contato já existente (mesma grafia do número) em vez de nascer outro", async () => {
    estado.contatoExistente = { id: "contact-9", phone_number: "+55 19 99999-9999" };

    const r = await ingestMetaAppContactSync(adminFalso(), CONTATO_DO_APP, { organizationId: "org-1" });

    expect(r).toEqual({ status: "synced", contactId: "contact-1" });
    expect(estado.rpcs[0]?.args.p_phone).toBe("+5519999999999");
  });

  it("`remove` (sem nome) não escreve nada — apagar do endereço não apaga do CRM", async () => {
    const r = await ingestMetaAppContactSync(
      adminFalso(),
      { ...CONTATO_DO_APP, name: null, action: "remove" },
      { organizationId: "org-1" },
    );

    expect(r).toEqual({ status: "ignored", reason: "sem_nome" });
    expect(estado.rpcs).toEqual([]);
  });

  it("sync de OUTRO número não vaza: sessão que não é dona não escreve uma linha", async () => {
    estado.sessao = null;

    const r = await ingestMetaAppContactSync(adminFalso(), CONTATO_DO_APP, { organizationId: "org-1" });

    expect(r).toEqual({ status: "no_session" });
    expect(estado.rpcs).toEqual([]);
    expect(estado.marcacoes).toEqual([]);
    expect(estado.pausas).toEqual([]);
  });

  it("número interno de avisos não vira contato", async () => {
    estado.numeroInterno = true;

    const r = await ingestMetaAppContactSync(adminFalso(), CONTATO_DO_APP, { organizationId: "org-1" });

    expect(r).toEqual({ status: "ignored", reason: "numero_interno_de_aviso" });
    expect(estado.rpcs).toEqual([]);
  });

  it("erro do upsert vira `failed` com o motivo, e não `synced` enganoso", async () => {
    estado.erroContato = { code: "42501", message: "permission denied" };

    const r = await ingestMetaAppContactSync(adminFalso(), CONTATO_DO_APP, { organizationId: "org-1" });

    expect(r).toEqual({ status: "failed", reason: "contato: permission denied" });
  });
});

describe("a rota do webhook oficial entrega o contato do app à ingestão", () => {
  it("payload bem assinado: 200, e o desfecho aparece como `contato:*`", async () => {
    vi.resetModules();
    const segredo = "app-secret-de-teste";
    vi.stubEnv("META_APP_SECRET", segredo);
    const sincronizados: unknown[] = [];

    vi.doMock("@/lib/channels/meta/session", () => ({
      metaSessionByWebhookToken: async () => ({ id: "sess-1", organizationId: "org-1", wabaId: "waba-1" }),
    }));
    vi.doMock("@/lib/channels/meta/app", () => ({
      appDaMeta: async () => ({ appSecret: segredo, verifyToken: null }),
    }));
    vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
    vi.doMock("@/lib/channels/meta/ingest", () => ({
      ingestMetaInbound: async () => ({ status: "ingested" }),
      ingestMetaEcho: async () => ({ status: "ingested" }),
      ingestMetaAppContactSync: async (_a: unknown, e: unknown) => {
        sincronizados.push(e);
        return { status: "synced", contactId: "contact-1" };
      },
    }));

    const { POST } = await import("@/app/api/v1/webhooks/meta/[token]/route");
    const cru = JSON.stringify(
      envelopeDeSync([
        {
          type: "contact",
          contact: { full_name: "Ana Souza", phone_number: "5519999999999" },
          action: "add",
          metadata: { timestamp: "1739321024" },
        },
      ]),
    );
    const res = await POST(
      {
        text: async () => cru,
        headers: new Headers({
          "x-hub-signature-256": `sha256=${createHmac("sha256", segredo).update(cru, "utf8").digest("hex")}`,
        }),
      } as never,
      { params: Promise.resolve({ token: "t" }) } as never,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: 1, outcomes: ["contato:synced"] });
    expect(sincronizados).toHaveLength(1);
    vi.unstubAllEnvs();
  });
});

describe("contato do app sem assinatura válida não chega à ingestão", () => {
  const segredo = "app-secret-de-teste";
  const cru = JSON.stringify(
    envelopeDeSync([
      { type: "contact", contact: { full_name: "Ana Souza", phone_number: "5519999999999" }, action: "add" },
    ]),
  );
  const casos: Array<[string, Record<string, string>]> = [
    ["sem header", {}],
    ["sha256 de zeros", { "x-hub-signature-256": `sha256=${"0".repeat(64)}` }],
    [
      "assinado com outro segredo",
      { "x-hub-signature-256": `sha256=${createHmac("sha256", "outro-segredo").update(cru, "utf8").digest("hex")}` },
    ],
  ];

  for (const [nome, headers] of casos) {
    it(`${nome}: 401 e nenhuma chamada a ingestMetaAppContactSync`, async () => {
      vi.resetModules();
      vi.stubEnv("META_APP_SECRET", segredo);
      const sincronizados: unknown[] = [];
      vi.doMock("@/lib/channels/meta/session", () => ({
        metaSessionByWebhookToken: async () => ({ id: "sess-1", organizationId: "org-1", wabaId: "waba-1" }),
      }));
      vi.doMock("@/lib/channels/meta/app", () => ({
        appDaMeta: async () => ({ appSecret: segredo, verifyToken: null }),
      }));
      vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
      vi.doMock("@/lib/channels/meta/ingest", () => ({
        ingestMetaInbound: async () => ({ status: "ingested" }),
        ingestMetaEcho: async () => ({ status: "ingested" }),
        ingestMetaAppContactSync: async (_a: unknown, e: unknown) => {
          sincronizados.push(e);
          return { status: "synced", contactId: "contact-1" };
        },
      }));

      const { POST } = await import("@/app/api/v1/webhooks/meta/[token]/route");
      const res = await POST(
        { text: async () => cru, headers: new Headers(headers) } as never,
        { params: Promise.resolve({ token: "t" }) } as never,
      );

      expect(res.status).toBe(401);
      expect(sincronizados).toEqual([]);
      vi.unstubAllEnvs();
    });
  }
});

describe("canal parceiro: contato do app de OUTRO número não vaza", () => {
  const SEGREDO = "whsec_segredo_do_painel_123";
  const TS = "1700000000";
  const assinado = (corpo: string) =>
    new Headers({
      "x-datafy-signature-256": `sha256=${createHmac("sha256", SEGREDO).update(`${TS}.${corpo}`).digest("hex")}`,
      "x-datafy-timestamp": TS,
    });

  async function entregar(phoneNumberIdDoPayload: string) {
    vi.resetModules();
    vi.stubEnv("DATAFY_ENABLED", "true");
    const sincronizados: unknown[] = [];
    vi.doMock("@/lib/channels/graph-parceiro/session", () => ({
      graphPartnerRefsDaSessao: async () => ({ phoneNumberId: "phone-1", wabaId: "waba-1" }),
    }));
    vi.doMock("@/lib/channels/meta/ingest", () => ({
      ingestMetaInbound: async () => ({ status: "ingested" }),
      ingestMetaEcho: async () => ({ status: "ingested" }),
      ingestMetaAppContactSync: async (_a: unknown, e: unknown) => {
        sincronizados.push(e);
        return { status: "synced", contactId: "contact-1" };
      },
    }));
    const { handleInboundWebhook } = await import("@/lib/channels/inbound");
    const { CHANNEL_PROVIDER_DATAFY } = await import("@/lib/channels/capabilities");
    const corpo = JSON.stringify(
      envelopeDeSync(
        [{ type: "contact", contact: { full_name: "Ana Souza", phone_number: "5519999999999" }, action: "add" }],
        phoneNumberIdDoPayload,
      ),
    );
    const r = await handleInboundWebhook({} as never, {
      session: { id: "sess-1", organization_id: "org-1", provider: CHANNEL_PROVIDER_DATAFY },
      rawBody: corpo,
      headers: assinado(corpo),
      secret: SEGREDO,
    });
    vi.unstubAllEnvs();
    return { r, sincronizados };
  }

  it("payload de outro `phone_number_id` da mesma conta: `outro_numero` e nenhuma ingestão", async () => {
    const { r, sincronizados } = await entregar("phone-OUTRO");

    expect(r).toEqual({ ok: true, body: { received: 1, outcomes: ["outro_numero"] } });
    expect(sincronizados).toEqual([]);
  });

  it("controle: o número DESTA sessão é ingerido", async () => {
    const { r, sincronizados } = await entregar("phone-1");

    expect(r).toEqual({ ok: true, body: { received: 1, outcomes: ["contato:synced"] } });
    expect(sincronizados).toHaveLength(1);
  });
});
