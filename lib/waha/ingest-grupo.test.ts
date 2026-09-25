import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/channels/pos-entrada", () => ({ aplicarEfeitosPosEntrada: vi.fn() }));
vi.mock("@/lib/dev/kick-local-pipeline", () => ({ acelerarPipelineDeEventos: vi.fn() }));
vi.mock("@/lib/escalacao/atendimento-manual", () => ({ pausarIaPorAtendimentoManual: vi.fn() }));
vi.mock("@/lib/leads/atribuicao-de-anuncio", () => ({ estamparAtribuicaoDoContato: vi.fn() }));
vi.mock("@/lib/plataformas-de-anuncio/google/atribuicao", () => ({ extrairEEstamparAtribuicaoGoogle: vi.fn() }));

import { audit } from "@/lib/audit";
import { aplicarEfeitosPosEntrada } from "@/lib/channels/pos-entrada";
import { acelerarPipelineDeEventos } from "@/lib/dev/kick-local-pipeline";
import { pausarIaPorAtendimentoManual } from "@/lib/escalacao/atendimento-manual";
import { estamparAtribuicaoDoContato } from "@/lib/leads/atribuicao-de-anuncio";
import { extrairEEstamparAtribuicaoGoogle } from "@/lib/plataformas-de-anuncio/google/atribuicao";
import { dispatchWahaEvent, remetenteDoGrupo, type WahaEnvelope, type WahaPayload } from "@/lib/waha/ingest";

/**
 * A ENTRADA DE GRUPO, medida pelo roteador que os dois webhooks chamam.
 *
 * O que este arquivo prova, e o que ele NÃO prova: o banco aqui é de mentira —
 * a corrida real, a RLS e o gatilho `message.group_received` são do `test:db`.
 * O que se mede aqui é a ORDEM das guardas do ingest: grupo desligado não
 * escreve nada; grupo ligado grava a mensagem com o remetente e não passa por
 * nenhum efeito da conversa individual (pós-entrada, pipeline, audit, contato
 * por participante, atribuição, pausa da IA); o eco de um envio nosso não entra
 * duas vezes.
 */

const ORG = "org-1";
const SESSION = { id: "sessao-1", organization_id: ORG };
const GRUPO = "120363000000000000@g.us";

interface Banco {
  admin: unknown;
  inserts: Array<{ tabela: string; linha: Record<string, unknown> }>;
  updates: Array<{ tabela: string; linha: Record<string, unknown> }>;
  rpcs: Array<{ fn: string; args: Record<string, unknown> }>;
}

function banco(cfg: {
  ligado?: { contact_id: string | null; conversation_id: string | null } | null;
  externosJaGravados?: string[];
} = {}): Banco {
  const inserts: Banco["inserts"] = [];
  const updates: Banco["updates"] = [];
  const rpcs: Banco["rpcs"] = [];
  const from = (tabela: string) => {
    const filtros = new Map<string, unknown>();
    let op = "select";
    const resposta = async () => {
      if (op === "insert") return { data: { id: `${tabela}-novo` }, error: null };
      if (tabela === "channel_session_groups" && op === "select") {
        const casa =
          cfg.ligado &&
          filtros.get("organization_id") === ORG &&
          filtros.get("channel_session_id") === SESSION.id &&
          filtros.get("group_chat_id") === GRUPO &&
          filtros.get("enabled") === true;
        return { data: casa ? { id: "g1", subject: "Clientes VIP", ...cfg.ligado } : null, error: null };
      }
      if (tabela === "messages" && op === "select") {
        const ids = (filtros.get("external_id") as string[] | undefined) ?? [];
        const achou = ids.find((i) => cfg.externosJaGravados?.includes(i));
        return { data: achou ? { id: "ja" } : null, error: null };
      }
      return { data: null, error: null };
    };
    const q = {
      select: () => q,
      insert: (linha: Record<string, unknown>) => { op = "insert"; inserts.push({ tabela, linha }); return q; },
      update: (linha: Record<string, unknown>) => { op = "update"; updates.push({ tabela, linha }); return q; },
      eq: (c: string, v: unknown) => { filtros.set(c, v); return q; },
      in: (c: string, v: unknown) => { filtros.set(c, v); return q; },
      is: () => q,
      gte: () => q,
      limit: () => q,
      order: () => q,
      single: resposta,
      maybeSingle: resposta,
      then: (ok: (v: unknown) => unknown) => resposta().then(ok),
    };
    return q;
  };
  const admin = {
    from,
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcs.push({ fn, args });
      return { data: null, error: null };
    },
  };
  return { admin, inserts, updates, rpcs };
}

function envelope(payload: WahaPayload): WahaEnvelope {
  return { event: "message.any", session: "default", payload };
}

const RECEBIDA: WahaPayload = {
  id: `false_${GRUPO}_3EB0AAA_70192801575156@lid`,
  from: GRUPO,
  fromMe: false,
  body: "bom dia, grupo",
  participant: "70192801575156@lid",
  _data: { pushName: "Maria", key: { participantAlt: "5521999990000@s.whatsapp.net" } },
};

const DO_CELULAR: WahaPayload = {
  id: `true_${GRUPO}_3EB0BBB`,
  from: GRUPO,
  fromMe: true,
  body: "respondi pelo celular",
  _data: { pushName: "Loja", key: {} },
};

const efeitosDaConversaIndividual = [
  aplicarEfeitosPosEntrada,
  acelerarPipelineDeEventos,
  pausarIaPorAtendimentoManual,
  estamparAtribuicaoDoContato,
  extrairEEstamparAtribuicaoGoogle,
  audit,
];

beforeEach(() => vi.clearAllMocks());

describe("grupo DESLIGADO — nada é escrito, como antes da feature", () => {
  it.each([
    ["recebida", RECEBIDA],
    ["enviada pelo celular", DO_CELULAR],
  ])("mensagem %s não escreve nada", async (_, payload) => {
    const b = banco({ ligado: null });
    await dispatchWahaEvent(b.admin as never, SESSION as never, envelope(payload), "req-1");
    expect(b.inserts).toEqual([]);
    expect(b.updates).toEqual([]);
    expect(b.rpcs).toEqual([]);
  });
});

describe("grupo LIGADO — a mensagem entra com o remetente e sem os efeitos da conversa individual", () => {
  it("recebida: cria contato e conversa DO GRUPO, grava com group_sender e carimba a conversa", async () => {
    const b = banco({ ligado: { contact_id: null, conversation_id: null } });
    await dispatchWahaEvent(b.admin as never, SESSION as never, envelope(RECEBIDA), "req-1");

    expect(b.inserts.map((i) => i.tabela)).toEqual(["contacts", "conversations", "messages"]);
    expect(b.inserts[0]!.linha).toMatchObject({ kind: "whatsapp_group", name: "Clientes VIP" });
    expect(b.inserts[1]!.linha).toMatchObject({ is_group: true, group_chat_id: GRUPO });
    expect(b.inserts[2]!.linha).toMatchObject({
      organization_id: ORG,
      direction: "inbound",
      external_id: RECEBIDA.id,
      body: "bom dia, grupo",
      metadata: { group_sender: { name: "Maria", phone: "+5521999990000", lid: "70192801575156" } },
    });
    expect(b.rpcs.map((r) => r.fn)).toEqual(["fn_mark_conversation_message"]);
    // Nenhum contato por participante: o upsert de contato individual nem é chamado.
    expect(b.rpcs.some((r) => r.fn === "fn_upsert_wa_contact")).toBe(false);
    for (const efeito of efeitosDaConversaIndividual) expect(efeito).not.toHaveBeenCalled();
  });

  it("enviada pelo celular: entra como outbound, sem remetente, sem pausar a IA", async () => {
    const b = banco({ ligado: { contact_id: "c-g", conversation_id: "v-g" } });
    await dispatchWahaEvent(b.admin as never, SESSION as never, envelope(DO_CELULAR), "req-1");

    const msg = b.inserts.find((i) => i.tabela === "messages")!.linha;
    expect(msg).toMatchObject({ direction: "outbound", conversation_id: "v-g", contact_id: "c-g", sent_via: "external_device" });
    expect((msg.metadata as Record<string, unknown>).group_sender).toBeUndefined();
    for (const efeito of efeitosDaConversaIndividual) expect(efeito).not.toHaveBeenCalled();
  });

  it("eco de uma resposta mandada pela inbox (id já gravado) não entra de novo", async () => {
    const b = banco({ ligado: { contact_id: "c-g", conversation_id: "v-g" }, externosJaGravados: ["3EB0BBB"] });
    await dispatchWahaEvent(b.admin as never, SESSION as never, envelope(DO_CELULAR), "req-1");
    expect(b.inserts).toEqual([]);
  });

  it("id de 4 segmentos (com participante) ainda acha o grupo pelo `from`", async () => {
    const b = banco({ ligado: { contact_id: "c-g", conversation_id: "v-g" } });
    await dispatchWahaEvent(
      b.admin as never,
      SESSION as never,
      envelope({ ...DO_CELULAR, id: `true_${GRUPO}_4CC5EDD64BC22EBA_9999@lid` }),
      "req-1",
    );
    expect(b.inserts.find((i) => i.tabela === "messages")?.linha).toMatchObject({ direction: "outbound" });
  });

  it("grupo ligado de OUTRO número não abre este", async () => {
    const b = banco({ ligado: { contact_id: "c-g", conversation_id: "v-g" } });
    await dispatchWahaEvent(b.admin as never, { id: "sessao-2", organization_id: ORG } as never, envelope(RECEBIDA), "req-1");
    expect(b.inserts).toEqual([]);
  });
});

describe("remetenteDoGrupo — quem escreveu, tirado do autor e nunca do `from`", () => {
  it("autor @lid com participantAlt: lid e telefone real", () => {
    expect(remetenteDoGrupo(RECEBIDA)).toEqual({ name: "Maria", phone: "+5521999990000", lid: "70192801575156" });
  });

  it("autor com telefone: o telefone vem do próprio autor", () => {
    expect(remetenteDoGrupo({ from: GRUPO, author: "5521999990000@c.us", _data: { notifyName: "João" } })).toEqual({
      name: "João",
      phone: "+5521999990000",
      lid: null,
    });
  });

  it("autor em `_data.key.participant` (forma do Baileys) também é lido", () => {
    expect(remetenteDoGrupo({ from: GRUPO, _data: { key: { participant: "70192801575156@lid" } } })).toEqual({
      name: null,
      phone: null,
      lid: "70192801575156",
    });
  });

  it("nunca usa o `from` (que é o grupo) como remetente", () => {
    expect(remetenteDoGrupo({ from: GRUPO })).toBeNull();
  });

  it("autor @lid com sufixo de dispositivo (:4) não perde o lid", () => {
    expect(remetenteDoGrupo({ from: GRUPO, author: "123456:4@lid", _data: { pushName: "Zé" } })).toEqual({
      name: "Zé",
      phone: null,
      lid: "123456",
    });
  });

  it("autor telefone com sufixo de dispositivo (:12) não perde o número", () => {
    expect(
      remetenteDoGrupo({ from: GRUPO, author: "5511999990000:12@s.whatsapp.net", _data: { pushName: "Ana" } }),
    ).toEqual({
      name: "Ana",
      phone: "+5511999990000",
      lid: null,
    });
  });

  it("forma desconhecida não lança: campo de outro tipo, lixo e nome enorme viram o que dá para guardar", () => {
    const r = remetenteDoGrupo({
      from: GRUPO,
      participant: 42 as never,
      author: "lixo@c.us",
      _data: { pushName: "x".repeat(500), key: { participantAlt: "abc@s.whatsapp.net" } },
    });
    expect(r).toEqual({ name: "x".repeat(200), phone: null, lid: null });
  });
});
