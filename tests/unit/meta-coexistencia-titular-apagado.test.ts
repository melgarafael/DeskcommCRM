import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Coexistência: o contato apagado a pedido (LGPD, `fn_titular_apagado_a_pedido`)
 * NÃO volta pela agenda do app WhatsApp Business.
 *
 * O importador de histórico já pergunta à função antes de importar
 * (`lib/channels/historico/rodada.ts`). A sincronização de contatos
 * (`smb_app_state_sync` → `ingestMetaAppContactSync`) não perguntava: a
 * anonimização ZERA o telefone do cadastro (`phone_number = null`,
 * migration 0280/0370/0497), `encontrarContatoPorTelefone` não acha a ficha por
 * nenhuma variante do número, e `fn_upsert_wa_contact` — que casa contato só por
 * `phone_number`/`wa_lid` — INSERE uma ficha nova com o número e o nome da agenda.
 * O titular que pediu para ser apagado volta ao cadastro com nome.
 *
 * É o defeito que este arquivo mede. `encontrarContatoPorTelefone` devolve `null`
 * aqui de propósito: é o que ele devolve para um contato anonimizado.
 *
 * A régua é a do importador de histórico: `true` ⇒ `ignored`; erro ou resposta
 * que não é booleano ⇒ `failed` (falha fechada, não cria na dúvida).
 */

const estado = vi.hoisted(() => ({
  rpcs: [] as Array<{ name: string; args: Record<string, unknown> }>,
  apagado: { data: false, error: null } as { data: unknown; error: { message: string } | null },
}));

vi.mock("@/lib/channels/contato-por-telefone", () => ({
  encontrarContatoPorTelefone: async () => null,
}));
vi.mock("@/lib/escalacao/numero-interno-de-aviso", () => ({
  ehNumeroInternoDeAviso: async () => false,
  registrarMensagemIgnorada: async () => undefined,
}));
vi.mock("@/lib/channels/marcar-conversa", () => ({ marcarConversaComMensagem: async () => undefined }));
vi.mock("@/lib/escalacao/atendimento-manual", () => ({ pausarIaPorAtendimentoManual: async () => true }));
vi.mock("@/lib/audit", () => ({ audit: async () => undefined }));

import { ingestMetaAppContactSync } from "@/lib/channels/meta/ingest";
import type { AppContactSyncEvent } from "@/lib/channels/meta/webhook";

function adminFalso(): SupabaseClient {
  const from = (table: string) => {
    if (table === "channel_sessions") {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        is: () => chain,
        maybeSingle: async () => ({ data: { id: "session-1", organization_id: "org-1" }, error: null }),
      };
      return chain;
    }
    if (table === "contacts") {
      return {
        update: () => {
          const chain: Record<string, unknown> = {
            eq: () => chain,
            then: (ok: (v: unknown) => unknown) => ok({ data: null, error: null }),
          };
          return chain;
        },
      };
    }
    throw new Error(`tabela inesperada: ${table}`);
  };
  const rpc = async (name: string, args: Record<string, unknown>) => {
    estado.rpcs.push({ name, args });
    if (name === "fn_titular_apagado_a_pedido") return estado.apagado;
    if (name === "fn_upsert_wa_contact") return { data: "contact-novo", error: null };
    return { data: null, error: null };
  };
  return { from, rpc } as unknown as SupabaseClient;
}

/** O evento da Meta: o número X continua na agenda do celular, com nome. */
const CONTATO_DA_AGENDA: AppContactSyncEvent = {
  kind: "app_contact_sync",
  wabaId: "waba-1",
  phoneNumberId: "phone-1",
  phone: "5519999999999",
  name: "Ana Souza",
  action: "add",
};

const DONO = { organizationId: "org-1" } as never;

/**
 * A recriação É o defeito, então esta asserção vem antes do desfecho: no
 * vermelho a mensagem diz "criou", não "devolveu outro status".
 */
const naoCriouContato = () =>
  expect(estado.rpcs.filter((r) => r.name === "fn_upsert_wa_contact")).toEqual([]);

beforeEach(() => {
  estado.rpcs = [];
  estado.apagado = { data: false, error: null };
});

describe("smb_app_state_sync e o titular apagado a pedido", () => {
  it("titular apagado: ignora e não recria o contato", async () => {
    estado.apagado = { data: true, error: null };

    const r = await ingestMetaAppContactSync(adminFalso(), CONTATO_DA_AGENDA, DONO);

    naoCriouContato();
    expect(r).toEqual({ status: "ignored", reason: "titular_apagado_a_pedido" });
    // Mesma assinatura do importador de histórico, com o telefone canônico do CRM.
    expect(estado.rpcs.find((x) => x.name === "fn_titular_apagado_a_pedido")?.args).toMatchObject({
      p_org: "org-1",
      p_telefone: "+5519999999999",
      p_lid: null,
    });
  });

  it("a pergunta falha: falha fechada, sem criar contato", async () => {
    estado.apagado = { data: null, error: { message: "boom" } };

    const r = await ingestMetaAppContactSync(adminFalso(), CONTATO_DA_AGENDA, DONO);

    naoCriouContato();
    expect(r.status).toBe("failed");
  });

  it("resposta sem booleano: falha fechada, sem criar contato", async () => {
    estado.apagado = { data: null, error: null };

    const r = await ingestMetaAppContactSync(adminFalso(), CONTATO_DA_AGENDA, DONO);

    naoCriouContato();
    expect(r.status).toBe("failed");
  });

  it("controle: titular não apagado segue o fluxo de hoje e grava o nome da agenda", async () => {
    const r = await ingestMetaAppContactSync(adminFalso(), CONTATO_DA_AGENDA, DONO);

    expect(r).toEqual({ status: "synced", contactId: "contact-novo" });
    expect(estado.rpcs.some((x) => x.name === "fn_upsert_wa_contact")).toBe(true);
  });
});
