/**
 * O "digitando…" atravessa o MESMO caminho de resolução do envio.
 *
 * Este teste dubla só o transporte HTTP (`getWahaClient`). Tudo entre a conversa
 * e o adapter é código real: a leitura escopada por `organization_id`, o
 * `resolveSessionRef` (que sabe de que coluna sai o ref de cada provider) e o
 * `resolveRecipient` (que sabe virar contato em endereço). Dublar o meio faria o
 * teste ficar verde com uma segunda maneira, divergente, de descobrir por qual
 * número falar — que é exatamente o defeito que a doutrina de canal proíbe.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const setPresence = vi.fn(async () => undefined);
/** null = transporte não configurado (env ausente), como numa VPS sem WAHA. */
let clienteDoTransporte: { setPresence: typeof setPresence } | null = { setPresence };

vi.mock("@/lib/waha/client", async (original) => ({
  ...(await original<typeof import("@/lib/waha/client")>()),
  getWahaClient: () => clienteDoTransporte,
}));

import { getAdapter } from "@/lib/channels";
import { sinalizarDigitando } from "@/lib/messaging/presenca";

interface LinhaDeConversa {
  is_group: boolean;
  group_chat_id: string | null;
  contacts: { phone_number: string | null; wa_identity: string | null; wa_lid: string | null } | null;
  channel_sessions:
    | { provider: string; waha_session_name: string | null; meta_phone_number_id: string | null; zernio_account_id: string | null; status: string }
    | null;
}

let linha: LinhaDeConversa | null = null;
/** `external_id` da última mensagem do cliente; `undefined` = conversa sem mensagem recebida. */
let ultimaDoCliente: string | null | undefined = "wamid.DO-CLIENTE";
/** Todo par (coluna, valor) que cada leitura filtrou, por tabela — a prova do escopo de tenant. */
let filtros: Record<string, Array<[string, unknown]>> = {};
/** Os argumentos de `not`, `order` e `limit`, por tabela: a ordem e o limite são o que escolhe "a última". */
let modificadores: Record<string, unknown[][]> = {};

function supabaseDeTeste(): never {
  const cadeia = (tabela: string) => {
    filtros[tabela] ??= [];
    const chain = {
      select: () => chain,
      eq: (col: string, val: unknown) => {
        filtros[tabela]!.push([col, val]);
        return chain;
      },
      not: (...args: unknown[]) => {
        (modificadores[tabela] ??= []).push(["not", ...args]);
        return chain;
      },
      order: (...args: unknown[]) => {
        (modificadores[tabela] ??= []).push(["order", ...args]);
        return chain;
      },
      limit: (...args: unknown[]) => {
        (modificadores[tabela] ??= []).push(["limit", ...args]);
        return chain;
      },
      maybeSingle: async () =>
        tabela === "messages"
          ? { data: ultimaDoCliente === undefined ? null : { external_id: ultimaDoCliente }, error: null }
          : { data: linha, error: null },
    };
    return chain;
  };
  return { from: cadeia } as never;
}

const CONVERSA_NORMAL: LinhaDeConversa = {
  is_group: false,
  group_chat_id: null,
  contacts: { phone_number: "+5527999998888", wa_identity: null, wa_lid: null },
  channel_sessions: {
    provider: "waha",
    waha_session_name: "sessao-do-sitio",
    meta_phone_number_id: null,
    zernio_account_id: null,
    status: "WORKING",
  },
};

beforeEach(() => {
  setPresence.mockClear();
  clienteDoTransporte = { setPresence };
  linha = structuredClone(CONVERSA_NORMAL);
  ultimaDoCliente = "wamid.DO-CLIENTE";
  filtros = {};
  modificadores = {};
  vi.restoreAllMocks();
});

describe("sinalizarDigitando", () => {
  it("acende 'digitando' no número da sessão e no endereço do contato", async () => {
    await sinalizarDigitando(supabaseDeTeste(), { organizationId: "org-1", conversationId: "conv-1" });

    expect(setPresence).toHaveBeenCalledTimes(1);
    expect(setPresence).toHaveBeenCalledWith("sessao-do-sitio", "5527999998888@c.us", "typing");
  });

  it("a leitura da conversa é escopada por organization_id", async () => {
    // Multi-tenancy (CLAUDE.md): quem usa service role filtra a organização à
    // mão, de fonte confiável. Sem esta linha, um id de conversa vazado
    // acenderia "digitando" no número de outro tenant.
    await sinalizarDigitando(supabaseDeTeste(), { organizationId: "org-1", conversationId: "conv-1" });
    expect(filtros.conversations).toContainEqual(["organization_id", "org-1"]);
    expect(filtros.conversations).toContainEqual(["id", "conv-1"]);
  });

  it("sessão que não está WORKING não recebe chamada de presença", async () => {
    linha!.channel_sessions!.status = "SCAN_QR_CODE";
    await sinalizarDigitando(supabaseDeTeste(), { organizationId: "org-1", conversationId: "conv-1" });
    expect(setPresence).not.toHaveBeenCalled();
  });

  it("conversa inexistente não chama o canal e não lança", async () => {
    linha = null;
    await expect(
      sinalizarDigitando(supabaseDeTeste(), { organizationId: "org-1", conversationId: "sumiu" }),
    ).resolves.toBeUndefined();
    expect(setPresence).not.toHaveBeenCalled();
  });

  it("contato sem endereço possível não vira chamada ao canal", async () => {
    linha!.contacts = { phone_number: null, wa_identity: null, wa_lid: null };
    await sinalizarDigitando(supabaseDeTeste(), { organizationId: "org-1", conversationId: "conv-1" });
    expect(setPresence).not.toHaveBeenCalled();
  });

  it("transporte não configurado (VPS sem o container) é no-op, não erro", async () => {
    clienteDoTransporte = null;
    await expect(
      sinalizarDigitando(supabaseDeTeste(), { organizationId: "org-1", conversationId: "conv-1" }),
    ).resolves.toBeUndefined();
  });

  it("canal que não sabe sinalizar presença é no-op", async () => {
    // O adapter do canal intermediado não implementa `signalTyping`. Quem chama
    // testa a presença do método — nunca pergunta QUAL provider é. (Este caso
    // usava o canal oficial, que passou a sinalizar.)
    linha!.channel_sessions = {
      provider: "zernio",
      waha_session_name: null,
      meta_phone_number_id: null,
      zernio_account_id: "conta-1",
      status: "WORKING",
    };
    expect(getAdapter("zernio").signalTyping).toBeUndefined();
    await expect(
      sinalizarDigitando(supabaseDeTeste(), { organizationId: "org-1", conversationId: "conv-1" }),
    ).resolves.toBeUndefined();
    expect(setPresence).not.toHaveBeenCalled();
    expect(filtros.messages).toBeUndefined();
  });
});

describe("sinalizarDigitando — a mensagem que se está respondendo", () => {
  const SESSAO_OFICIAL = {
    provider: "meta_cloud",
    waha_session_name: null,
    meta_phone_number_id: "123456",
    zernio_account_id: null,
    status: "WORKING",
  };

  it("o canal oficial recebe o external_id da última mensagem do cliente", async () => {
    // Na Cloud API o "digitando" é da MENSAGEM recebida (`message_id`), não da
    // conversa: sem o id o canal não tem o que sinalizar.
    linha!.channel_sessions = { ...SESSAO_OFICIAL };
    const sinal = vi.spyOn(getAdapter("meta_cloud"), "signalTyping").mockResolvedValue(undefined);

    await sinalizarDigitando(supabaseDeTeste(), { organizationId: "org-1", conversationId: "conv-1" });

    expect(sinal).toHaveBeenCalledTimes(1);
    expect(sinal).toHaveBeenCalledWith({
      organizationId: "org-1",
      sessionRef: "123456",
      recipient: "5527999998888",
      inboundExternalId: "wamid.DO-CLIENTE",
    });
  });

  it("a busca da última mensagem é escopada por organização, conversa e direção", async () => {
    linha!.channel_sessions = { ...SESSAO_OFICIAL };
    vi.spyOn(getAdapter("meta_cloud"), "signalTyping").mockResolvedValue(undefined);

    await sinalizarDigitando(supabaseDeTeste(), { organizationId: "org-1", conversationId: "conv-1" });

    expect(filtros.messages).toContainEqual(["organization_id", "org-1"]);
    expect(filtros.messages).toContainEqual(["conversation_id", "conv-1"]);
    expect(filtros.messages).toContainEqual(["direction", "inbound"]);
  });

  it("pega a MAIS RECENTE pela hora da mensagem, uma só, sem reação nem sistema", async () => {
    // Crescente pegaria a primeira mensagem da conversa (a Meta recusa ler a de
    // mais de 30 dias); sem o limite, `maybeSingle` erra em toda conversa com
    // duas mensagens e o indicador morre calado. Reação não é mensagem a responder.
    linha!.channel_sessions = { ...SESSAO_OFICIAL };
    vi.spyOn(getAdapter("meta_cloud"), "signalTyping").mockResolvedValue(undefined);

    await sinalizarDigitando(supabaseDeTeste(), { organizationId: "org-1", conversationId: "conv-1" });

    expect(modificadores.messages?.[0]).toEqual(["not", "type", "in", "(reaction,system)"]);
    expect(modificadores.messages?.[1]).toEqual(["order", "sent_at", { ascending: false, nullsFirst: false }]);
    expect(modificadores.messages).toContainEqual(["limit", 1]);
  });

  it("conversa sem mensagem recebida chega ao canal com null — quem decide é o canal", async () => {
    linha!.channel_sessions = { ...SESSAO_OFICIAL };
    ultimaDoCliente = undefined;
    const sinal = vi.spyOn(getAdapter("meta_cloud"), "signalTyping").mockResolvedValue(undefined);

    await sinalizarDigitando(supabaseDeTeste(), { organizationId: "org-1", conversationId: "conv-1" });

    expect(sinal).toHaveBeenCalledWith(expect.objectContaining({ inboundExternalId: null }));
  });
});
