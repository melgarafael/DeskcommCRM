import { describe, expect, it } from "vitest";

import type { EventRow } from "@/lib/event-log/dispatcher";
import { triggerConfigSchema } from "./api-schemas";
import type { FollowupGateDb } from "./agent-followup-gate";
import {
  EVENTO_DE_MENSAGEM,
  EVENTO_DO_ENROLLMENT_POR_MENSAGEM,
  aplicaGatilhoDeMensagem,
  gatilhoDoPointer,
  type GatilhoMensagemDb,
  type PointerDeMensagem,
} from "./gatilho-mensagem";
import {
  casaCodigoDoLink,
  casaPalavraChave,
  linkDeEntrada,
  ordenarCandidatos,
  respostaPadraoEmPausa,
  veioDeAnuncio,
} from "./gatilho-mensagem-regra";

const ORG = "11111111-1111-1111-1111-111111111111";
const CONTATO = "55555555-5555-5555-5555-555555555555";
const CONVERSA = "66666666-6666-6666-6666-666666666666";
const MENSAGEM = "77777777-7777-7777-7777-777777777777";
const SESSAO = "88888888-8888-8888-8888-888888888888";
const AGORA = new Date("2026-10-22T15:00:00.000Z");

describe("a regra das palavras-chave", () => {
  it("ignora maiúsculas, acentos e pontuação", () => {
    expect(casaPalavraChave("Quero a PROMOÇÃO!", ["promocao"], "contem")).toBe(true);
    expect(casaPalavraChave("preço?", ["Preço"], "exato")).toBe(true);
  });

  it("contém casa palavra inteira, nunca pedaço", () => {
    expect(casaPalavraChave("o boi fugiu", ["oi"], "contem")).toBe(false);
    expect(casaPalavraChave("oi, tudo bem", ["oi"], "contem")).toBe(true);
    expect(casaPalavraChave("quero comprar agora", ["quero comprar"], "contem")).toBe(true);
  });

  it("exato e começa com", () => {
    expect(casaPalavraChave("promo de natal", ["promo"], "exato")).toBe(false);
    expect(casaPalavraChave("promo de natal", ["promo"], "comeca_com")).toBe(true);
    expect(casaPalavraChave("a promo", ["promo"], "comeca_com")).toBe(false);
  });

  it("mensagem sem texto (áudio, figurinha) não casa", () => {
    expect(casaPalavraChave(null, ["promo"], "contem")).toBe(false);
    expect(casaPalavraChave("   ", ["promo"], "contem")).toBe(false);
  });
});

describe("o link e o QR de entrada", () => {
  it("o link preenche a frase com o código no fim, só dígitos no número", () => {
    expect(linkDeEntrada("+55 (11) 99999-0000", "promo-natal", "Quero o cupom")).toBe(
      "https://wa.me/5511999990000?text=Quero%20o%20cupom%20%23promo-natal",
    );
    expect(linkDeEntrada("5511999990000", "abc")).toBe("https://wa.me/5511999990000?text=%23abc");
  });

  it("casa o código como palavra, com o #", () => {
    expect(casaCodigoDoLink("Quero o cupom #promo-natal", "promo-natal")).toBe(true);
    expect(casaCodigoDoLink("Quero o cupom #PROMO-NATAL", "promo-natal")).toBe(true);
    expect(casaCodigoDoLink("promo-natal", "promo-natal")).toBe(false);
    expect(casaCodigoDoLink("#promo-natal-2", "promo-natal")).toBe(false);
  });

  it("o contrato recusa código fora do padrão", () => {
    const ok = triggerConfigSchema.safeParse({ kind: "ref_link", params: { codigo: "promo-natal" } });
    const ruim = triggerConfigSchema.safeParse({ kind: "ref_link", params: { codigo: "Promo Natal" } });
    expect(ok.success).toBe(true);
    expect(ruim.success).toBe(false);
  });
});

describe("o anúncio de clique para o WhatsApp", () => {
  const anuncio = { ad_id: "120200", ad_source_id: "clid", capturado_em: new Date(AGORA.getTime() - 2_000) };

  it("vale só quando a atribuição é desta mensagem", () => {
    expect(veioDeAnuncio({ texto: "oi", recebida_em: AGORA, anuncio }, [])).toBe(true);
    const velha = { ...anuncio, capturado_em: new Date(AGORA.getTime() - 3 * 24 * 3600_000) };
    expect(veioDeAnuncio({ texto: "oi", recebida_em: AGORA, anuncio: velha }, [])).toBe(false);
    expect(veioDeAnuncio({ texto: "oi", recebida_em: AGORA, anuncio: null }, [])).toBe(false);
  });

  it("filtra pelo id do anúncio quando a lista existe", () => {
    expect(veioDeAnuncio({ texto: "oi", recebida_em: AGORA, anuncio }, ["120200"])).toBe(true);
    expect(veioDeAnuncio({ texto: "oi", recebida_em: AGORA, anuncio }, ["999"])).toBe(false);
  });
});

describe("prioridade e pausa", () => {
  it("link vence palavra, palavra vence anúncio", () => {
    const fatos = {
      texto: "promo #natal",
      recebida_em: AGORA,
      anuncio: { ad_id: "1", ad_source_id: null, capturado_em: AGORA },
    };
    const ordem = ordenarCandidatos(
      [
        { id: "a", gatilho: { kind: "ad_click" as const, anuncios: [] } },
        { id: "k", gatilho: { kind: "keyword" as const, palavras: ["promo"], modo: "contem" as const } },
        { id: "r", gatilho: { kind: "ref_link" as const, codigo: "natal" } },
      ],
      fatos,
    );
    expect(ordem.map((p) => p.id)).toEqual(["r", "k", "a"]);
  });

  it("a resposta padrão respeita o intervalo por contato", () => {
    expect(respostaPadraoEmPausa(null, AGORA, 24)).toBe(false);
    expect(respostaPadraoEmPausa(new Date(AGORA.getTime() - 3600_000), AGORA, 24)).toBe(true);
    expect(respostaPadraoEmPausa(new Date(AGORA.getTime() - 25 * 3600_000), AGORA, 24)).toBe(false);
  });

  it("o ponteiro lê as palavras já limpas", () => {
    expect(gatilhoDoPointer({ kind: "keyword", params: { palavras: ["Promoção", "promocao", " "], modo: "contem" } }))
      .toBeNull(); // palavra em branco é recusada pelo contrato
    expect(gatilhoDoPointer({ kind: "keyword", params: { palavras: ["Promoção", "promocao"], modo: "contem" } })).toEqual({
      kind: "keyword",
      palavras: ["promocao"],
      modo: "contem",
    });
    expect(gatilhoDoPointer({ kind: "silence", params: { threshold_minutes: 60 } })).toBeNull();
  });
});

// ─── o produtor contra um banco falso ─────────────────────────────────────

interface Registro {
  enrollments: Array<{ pointer_id: string }>;
  eventos: Array<{ event_type: string; payload: Record<string, unknown>; idempotency_key: string }>;
}

function fakeDb(opts: {
  pointers: PointerDeMensagem[];
  texto?: string | null;
  humano?: boolean;
  vivo?: boolean;
  agente?: boolean;
  ultimaPadrao?: Date | null;
  registro: Registro;
}): GatilhoMensagemDb {
  return {
    async carregaPointersDeMensagem() {
      return opts.pointers;
    },
    async carregaMensagem() {
      return { texto: opts.texto === undefined ? "oi" : opts.texto, recebida_em: AGORA, channel_session_id: SESSAO };
    },
    async carregaAnuncioDoContato() {
      return null;
    },
    async haAgenteQueResponde() {
      return opts.agente ?? false;
    },
    async ultimaRespostaPadrao() {
      return opts.ultimaPadrao ?? null;
    },
    async carregaEstadoDaConversa() {
      return {
        is_group: false,
        is_blocked: false,
        force_human: false,
        assignee_kind: opts.humano ? "user" : "ai",
        bot_silenced_until: null,
        tags: [],
      };
    },
    async carregaEnrollmentVivo() {
      return opts.vivo ? { pointer_id: "outro" } : null;
    },
    async carregaNoDeGatilho() {
      return { id: "t1", pedeAgente: false };
    },
    async insereEnrollment(input) {
      opts.registro.enrollments.push({ pointer_id: input.pointer_id });
      return { inserted: true, id: `enr-${input.pointer_id}` };
    },
    async insereEventoDoEnrollment(evento) {
      opts.registro.eventos.push({
        event_type: evento.event_type,
        payload: evento.payload,
        idempotency_key: evento.idempotency_key,
      });
    },
  };
}

const gate: FollowupGateDb = {
  async loadEnabledPublishedFollowupAgents() {
    return [];
  },
};

function evento(): EventRow {
  return {
    id: "e0000000-0000-4000-8000-000000000001",
    organization_id: ORG,
    event_type: EVENTO_DE_MENSAGEM,
    entity_kind: "message",
    entity_id: MENSAGEM,
    payload: { contact_id: CONTATO, conversation_id: CONVERSA, message_id: MENSAGEM },
    metadata: {},
    consumed_by: [],
    attempts: 0,
  };
}

const PALAVRA: PointerDeMensagem = {
  id: "p-palavra",
  active_version_id: "v1",
  gatilho: { kind: "keyword", palavras: ["promo"], modo: "contem" },
};
const PADRAO: PointerDeMensagem = {
  id: "p-padrao",
  active_version_id: "v2",
  gatilho: { kind: "default_reply", intervalo_horas: 24 },
};

describe("aplicaGatilhoDeMensagem", () => {
  it("a palavra-chave inscreve, sem agente, e grava o message_id para o silenciador", async () => {
    const reg: Registro = { enrollments: [], eventos: [] };
    const s = await aplicaGatilhoDeMensagem(
      { db: fakeDb({ pointers: [PALAVRA, PADRAO], texto: "quero a PROMO", registro: reg }), gateDb: gate, clock: () => AGORA },
      evento(),
      "especificos",
    );
    expect(s.enrolled).toBe(1);
    expect(reg.enrollments).toEqual([{ pointer_id: "p-palavra" }]);
    expect(reg.eventos[0]?.event_type).toBe(EVENTO_DO_ENROLLMENT_POR_MENSAGEM);
    expect(reg.eventos[0]?.payload.message_id).toBe(MENSAGEM);
    expect(reg.eventos[0]?.payload.trigger_kind).toBe("keyword");
  });

  it("mensagem que não casa não inscreve na fase dos específicos", async () => {
    const reg: Registro = { enrollments: [], eventos: [] };
    const s = await aplicaGatilhoDeMensagem(
      { db: fakeDb({ pointers: [PALAVRA], texto: "bom dia", registro: reg }), gateDb: gate, clock: () => AGORA },
      evento(),
      "especificos",
    );
    expect(s.pointers_casados).toBe(0);
    expect(reg.enrollments).toHaveLength(0);
  });

  it("humano no comando ou fluxo vivo seguram tudo", async () => {
    for (const o of [{ humano: true }, { vivo: true }]) {
      const reg: Registro = { enrollments: [], eventos: [] };
      await aplicaGatilhoDeMensagem(
        { db: fakeDb({ pointers: [PALAVRA], texto: "promo", registro: reg, ...o }), gateDb: gate, clock: () => AGORA },
        evento(),
        "especificos",
      );
      expect(reg.enrollments).toHaveLength(0);
    }
  });

  it("a resposta padrão fala quando nada falou — e cede ao agente e à pausa", async () => {
    const livre: Registro = { enrollments: [], eventos: [] };
    await aplicaGatilhoDeMensagem(
      { db: fakeDb({ pointers: [PALAVRA, PADRAO], texto: "bom dia", registro: livre }), gateDb: gate, clock: () => AGORA },
      evento(),
      "padrao",
    );
    expect(livre.enrollments).toEqual([{ pointer_id: "p-padrao" }]);

    const comAgente: Registro = { enrollments: [], eventos: [] };
    const s1 = await aplicaGatilhoDeMensagem(
      { db: fakeDb({ pointers: [PADRAO], agente: true, registro: comAgente }), gateDb: gate, clock: () => AGORA },
      evento(),
      "padrao",
    );
    expect(s1.skipped_agente).toBe(1);
    expect(comAgente.enrollments).toHaveLength(0);

    const emPausa: Registro = { enrollments: [], eventos: [] };
    const s2 = await aplicaGatilhoDeMensagem(
      {
        db: fakeDb({ pointers: [PADRAO], ultimaPadrao: new Date(AGORA.getTime() - 3600_000), registro: emPausa }),
        gateDb: gate,
        clock: () => AGORA,
      },
      evento(),
      "padrao",
    );
    expect(s2.skipped_pausa).toBe(1);
    expect(emPausa.enrollments).toHaveLength(0);
  });
});
