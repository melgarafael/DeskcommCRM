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
import {
  dispatchWahaEvent,
  mencoesDoGrupo,
  remetenteDoGrupo,
  type WahaEnvelope,
  type WahaPayload,
} from "@/lib/waha/ingest";

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
  /** As tabelas lidas (op `select`), na ordem — #3566 cobra a conta das leituras. */
  consultas: string[];
}

function banco(cfg: {
  ligado?: { contact_id: string | null; conversation_id: string | null } | null;
  externosJaGravados?: string[];
  /** #3566 — os contatos que o rótulo da menção pode achar. */
  contatos?: Array<{ name: string | null; display_name: string | null; phone_number: string | null; wa_lid: string | null }>;
} = {}): Banco {
  const inserts: Banco["inserts"] = [];
  const updates: Banco["updates"] = [];
  const rpcs: Banco["rpcs"] = [];
  const consultas: Banco["consultas"] = [];
  const from = (tabela: string) => {
    const filtros = new Map<string, unknown>();
    let op = "select";
    const resposta = async () => {
      if (op === "insert") return { data: { id: `${tabela}-novo` }, error: null };
      consultas.push(tabela);
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
      if (tabela === "contacts" && op === "select") {
        const porLid = filtros.get("wa_lid") as string[] | undefined;
        const porTelefone = filtros.get("phone_number") as string[] | undefined;
        const linhas = (cfg.contatos ?? []).filter(
          (c) =>
            (porLid && c.wa_lid !== null && porLid.includes(c.wa_lid)) ||
            (porTelefone && c.phone_number !== null && porTelefone.includes(c.phone_number)),
        );
        return { data: linhas, error: null };
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
  return { admin, inserts, updates, rpcs, consultas };
}

function envelope(payload: WahaPayload): WahaEnvelope {
  return { event: "message.any", session: "default", payload };
}

const RECEBIDA: WahaPayload = {
  id: `false_${GRUPO}_3EB0AAA_100000000000001@lid`,
  from: GRUPO,
  fromMe: false,
  body: "bom dia, grupo",
  participant: "100000000000001@lid",
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
      metadata: { group_sender: { name: "Maria", phone: "+5521999990000", lid: "100000000000001" } },
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
    expect(remetenteDoGrupo(RECEBIDA)).toEqual({ name: "Maria", phone: "+5521999990000", lid: "100000000000001" });
  });

  it("autor com telefone: o telefone vem do próprio autor", () => {
    expect(remetenteDoGrupo({ from: GRUPO, author: "5521999990000@c.us", _data: { notifyName: "João" } })).toEqual({
      name: "João",
      phone: "+5521999990000",
      lid: null,
    });
  });

  it("autor em `_data.key.participant` (forma do Baileys) também é lido", () => {
    expect(remetenteDoGrupo({ from: GRUPO, _data: { key: { participant: "100000000000001@lid" } } })).toEqual({
      name: null,
      phone: null,
      lid: "100000000000001",
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

/**
 * #3566 — AS MENÇÕES: a lista que faltava guardar.
 *
 * O defeito relatado: em grupo o WhatsApp escreve `@75235009282237` no texto, e
 * quem foi mencionado se perdia na entrada — `metadata.group_sender` dizia quem
 * ESCREVEU, e nada dizia quem foi CHAMADO. O que se mede aqui é a entrada: a
 * lista vai para `metadata.mentions` com o rótulo do contato do CRM, pelo MESMO
 * leitor de JID do remetente, e o `body` continua CRU (a exibição resolve).
 */
const MENCIONANDO: WahaPayload = {
  id: `false_${GRUPO}_3EB0CCC_100000000000001@lid`,
  from: GRUPO,
  fromMe: false,
  body: "oi @75235009282237, pode vir?",
  participant: "100000000000001@lid",
  _data: {
    pushName: "Maria",
    key: { participantAlt: "5521999990000@s.whatsapp.net" },
    message: {
      extendedTextMessage: {
        text: "oi @75235009282237, pode vir?",
        contextInfo: { mentionedJid: ["75235009282237@lid"] },
      },
    },
  },
};

const MARIA_NO_CRM = {
  name: null,
  display_name: "Maria Exemplo",
  phone_number: "+5511999990000",
  wa_lid: "75235009282237",
};

describe("#3566 — menção em grupo: guarda a lista e NÃO reescreve o texto", () => {
  it("grava metadata.mentions com o nome do contato, e o body continua com o @lid", async () => {
    const b = banco({ ligado: { contact_id: "c-g", conversation_id: "v-g" }, contatos: [MARIA_NO_CRM] });
    await dispatchWahaEvent(b.admin as never, SESSION as never, envelope(MENCIONANDO), "req-1");

    const msg = b.inserts.find((i) => i.tabela === "messages")!.linha;
    // O TEXTO CRU fica no banco: a resolução é da exibição.
    expect(msg.body).toBe("oi @75235009282237, pode vir?");
    expect((msg.metadata as Record<string, unknown>).mentions).toEqual([
      { lid: "75235009282237", phone: null, name: "Maria Exemplo" },
    ]);
  });

  it("menção a quem NÃO está no CRM entra sem nome — a tela mostra o número, como hoje", async () => {
    const b = banco({ ligado: { contact_id: "c-g", conversation_id: "v-g" }, contatos: [] });
    await dispatchWahaEvent(b.admin as never, SESSION as never, envelope(MENCIONANDO), "req-1");

    expect((b.inserts.find((i) => i.tabela === "messages")!.linha.metadata as Record<string, unknown>).mentions).toEqual([
      { lid: "75235009282237", phone: null, name: null },
    ]);
  });

  it("menção que chega como NÚMERO acha o contato pelas duas grafias do nono dígito", async () => {
    const b = banco({
      ligado: { contact_id: "c-g", conversation_id: "v-g" },
      // Gravado COM o nono dígito; a menção chega SEM ele.
      contatos: [MARIA_NO_CRM],
    });
    await dispatchWahaEvent(
      b.admin as never,
      SESSION as never,
      envelope({
        ...MENCIONANDO,
        body: "oi @5511988887777",
        _data: {
          ...MENCIONANDO._data,
          message: { extendedTextMessage: { contextInfo: { mentionedJid: ["5511988887777@s.whatsapp.net"] } } },
        },
      }),
      "req-1",
    );
    const mencoes = (b.inserts.find((i) => i.tabela === "messages")!.linha.metadata as Record<string, unknown>)
      .mentions as Array<Record<string, unknown>>;
    expect(mencoes[0]).toMatchObject({ phone: "+5511988887777", lid: null });
  });

  it("CONTROLE: mensagem sem menção não ganha a chave e não paga leitura de contato", async () => {
    const b = banco({ ligado: { contact_id: "c-g", conversation_id: "v-g" } });
    await dispatchWahaEvent(b.admin as never, SESSION as never, envelope(RECEBIDA), "req-1");

    const metadata = b.inserts.find((i) => i.tabela === "messages")!.linha.metadata as Record<string, unknown>;
    expect(Object.keys(metadata)).toEqual(["raw_type", "group_sender"]);
    expect(metadata.mentions).toBeUndefined();
    expect(b.consultas).not.toContain("contacts");
  });
});

describe("mencoesDoGrupo — o mesmo leitor de JID do remetente", () => {
  it("lê o `mentionedJid` do contextInfo do Baileys", () => {
    expect(mencoesDoGrupo(MENCIONANDO)).toEqual([{ name: null, phone: null, lid: "75235009282237" }]);
  });

  it("sufixo de dispositivo, item de outro tipo, JID irreconhecível e repetido não sujam a lista", () => {
    expect(
      mencoesDoGrupo({
        from: GRUPO,
        _data: {
          message: {
            extendedTextMessage: {
              contextInfo: {
                mentionedJid: ["75235009282237:4@lid", "75235009282237@lid", 42, "lixo@lid", "99887766554433@lid"],
              },
            },
          },
        },
      }),
    ).toEqual([
      { name: null, phone: null, lid: "75235009282237" },
      { name: null, phone: null, lid: "99887766554433" },
    ]);
  });

  it("sem contextInfo, sem lista ou sem menção: lista vazia, e nada lança", () => {
    expect(mencoesDoGrupo({ from: GRUPO })).toEqual([]);
    expect(mencoesDoGrupo({ from: GRUPO, _data: { message: { extendedTextMessage: {} } } })).toEqual([]);
    expect(mencoesDoGrupo({ from: GRUPO, _data: { message: { contextInfo: { mentionedJid: "x" } } } })).toEqual([]);
    // O AUTOR da mensagem não é menção: `participant` sozinho não produz lista.
    expect(mencoesDoGrupo({ from: GRUPO, participant: "100000000000001@lid" })).toEqual([]);
  });
});
