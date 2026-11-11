import { describe, expect, it } from "vitest";

import {
  AI_ALLOWLIST_TTL_DAYS_DEFAULT,
  decidirElegibilidade,
  lerModoDoGate,
  montarEstadoDeElegibilidade,
  ttlDaAutorizacaoMs,
  type EstadoDeElegibilidade,
} from "./gate";

const AGORA = new Date("2026-08-27T12:00:00Z");
const DIA = 24 * 60 * 60 * 1000;

const base: EstadoDeElegibilidade = {
  orgStatus: "active",
  canalDesativado: false,
  modo: "open",
  forceHuman: false,
  contatoInterno: false,
  // #3534: a régua da equipe é o oposto da interna — autoriza em vez de vetar.
  // `false` aqui é o contato comum, que segue a régua do canal.
  contatoDaEquipe: false,
  aiOptOut: false,
  botSilencedUntil: null,
  assigneeKind: "ai",
  // #3967: ausente por padrão — o modo é explícito e por conversa.
  iaComDono: false,
  aiAuthorizedAt: null,
  preGoLiveAtivo: false,
  numeroDeTesteAutorizado: false,
  agora: AGORA,
  ttlMs: 21 * DIA,
};

describe("lerModoDoGate", () => {
  it("só 'allowlist' liga o modo; resto (ausente/null/lixo) é 'open'", () => {
    expect(lerModoDoGate("allowlist")).toBe("allowlist");
    expect(lerModoDoGate("open")).toBe("open");
    expect(lerModoDoGate(undefined)).toBe("open");
    expect(lerModoDoGate(null)).toBe("open");
    expect(lerModoDoGate("ALLOWLIST")).toBe("open");
    expect(lerModoDoGate(42)).toBe("open");
  });
});

describe("decidirElegibilidade — gate 'open' (comportamento de hoje)", () => {
  it("mensagem genérica sem autorização: PERMITE (nada muda para quem não configurou)", () => {
    const d = decidirElegibilidade({ ...base, modo: "open" });
    expect(d.permite).toBe(true);
    expect(d.motivo).toBe("gate_aberto");
  });

  it("force_human bloqueia mesmo com gate aberto", () => {
    const d = decidirElegibilidade({ ...base, modo: "open", forceHuman: true });
    expect(d.permite).toBe(false);
    expect(d.motivo).toBe("force_human");
    expect(d.bloqueioPorAllowlist).toBe(false);
  });

  it("#2379: 'sempre atendimento humano' bloqueia sozinho — mesmo com force_human já limpo e autorização vigente", () => {
    const d = decidirElegibilidade({
      ...base,
      modo: "allowlist",
      forceHuman: false,
      aiOptOut: true,
      aiAuthorizedAt: new Date(AGORA.getTime() - DIA),
    });
    expect(d.permite).toBe(false);
    expect(d.motivo).toBe("ai_opt_out");
    expect(d.bloqueioPorAllowlist).toBe(false);
  });

  it("#2379: montarEstadoDeElegibilidade só liga a marca com true literal", () => {
    const cru = {
      aiGate: "open",
      forceHuman: false,
      assigneeKind: null,
      metadataDaConversa: null,
      botSilencedUntil: null,
      aiAuthorizedAt: null,
      orgStatus: "active",
      agora: AGORA,
      ttlMs: DIA,
    };
    expect(montarEstadoDeElegibilidade({ ...cru, aiOptOut: true }).aiOptOut).toBe(true);
    expect(montarEstadoDeElegibilidade({ ...cru, aiOptOut: null }).aiOptOut).toBe(false);
    expect(montarEstadoDeElegibilidade({ ...cru, aiOptOut: "true" }).aiOptOut).toBe(false);
  });

  it("conversa com dono humano bloqueia mesmo com gate aberto", () => {
    const d = decidirElegibilidade({ ...base, modo: "open", assigneeKind: "user" });
    expect(d.permite).toBe(false);
    expect(d.motivo).toBe("conversa_de_humano");
  });

  /**
   * O MODO EXPLÍCITO POR CONVERSA (#3967) — a IA responde SEM soltar o dono.
   *
   * O dono humano é veto absoluto desde a 0032, e a única volta era
   * `devolverAtendimentoAoAgente`, que faz `release`: a conversa sai da carteira
   * de quem estava atendendo. O modo é o estado que desliga SÓ esse veto, na
   * conversa em que alguém o ligou, e nada mais.
   */
  describe("modo 'IA com o dono'", () => {
    it("dono humano + modo LIGADO → a IA responde; o dono continua o mesmo", () => {
      const d = decidirElegibilidade({ ...base, modo: "open", assigneeKind: "user", iaComDono: true });
      expect(d.permite).toBe(true);
      expect(d.motivo).toBe("gate_aberto");
    });

    it("dono humano + modo DESLIGADO/ausente → silêncio de hoje (conversa_de_humano)", () => {
      expect(decidirElegibilidade({ ...base, modo: "open", assigneeKind: "user", iaComDono: false }).motivo).toBe(
        "conversa_de_humano",
      );
      expect(decidirElegibilidade({ ...base, modo: "open", assigneeKind: "user" }).motivo).toBe("conversa_de_humano");
    });

    it("o modo NÃO fura as outras travas: force_human, opt-out, silêncio e contato interno continuam vetando", () => {
      const modo = { ...base, modo: "open" as const, assigneeKind: "user", iaComDono: true };
      expect(decidirElegibilidade({ ...modo, forceHuman: true }).motivo).toBe("force_human");
      expect(decidirElegibilidade({ ...modo, aiOptOut: true }).motivo).toBe("ai_opt_out");
      expect(decidirElegibilidade({ ...modo, contatoInterno: true }).motivo).toBe("contato_interno");
      expect(
        decidirElegibilidade({ ...modo, botSilencedUntil: new Date(AGORA.getTime() + DIA) }).motivo,
      ).toBe("conversa_silenciada");
    });

    it("o modo NÃO afrouxa o allowlist: dono + modo ligado sem autorização continua barrado", () => {
      const d = decidirElegibilidade({ ...base, modo: "allowlist", assigneeKind: "user", iaComDono: true });
      expect(d.permite).toBe(false);
      expect(d.motivo).toBe("sem_autorizacao");
      expect(d.bloqueioPorAllowlist).toBe(true);
    });

    it("o modo é inerte em conversa SEM dono: não autoriza nada que o canal já não autorizasse", () => {
      expect(decidirElegibilidade({ ...base, modo: "open", assigneeKind: null, iaComDono: true }).motivo).toBe(
        "gate_aberto",
      );
      expect(decidirElegibilidade({ ...base, modo: "open", assigneeKind: "user", iaComDono: true }).permite).toBe(true);
    });
  });

  it("bot silenciado até o futuro bloqueia; silêncio no passado não", () => {
    expect(
      decidirElegibilidade({ ...base, modo: "open", botSilencedUntil: new Date(AGORA.getTime() + DIA) }).permite,
    ).toBe(false);
    expect(
      decidirElegibilidade({ ...base, modo: "open", botSilencedUntil: new Date(AGORA.getTime() - DIA) }).permite,
    ).toBe(true);
    expect(
      decidirElegibilidade({ ...base, modo: "open", botSilencedUntil: Number.POSITIVE_INFINITY }).permite,
    ).toBe(false);
  });
});

describe("decidirElegibilidade — gate 'allowlist' (deny by default)", () => {
  it("teste 1/3/4/9: mensagem comum de contato NÃO autorizado → NÃO responde", () => {
    const d = decidirElegibilidade({ ...base, modo: "allowlist", aiAuthorizedAt: null });
    expect(d.permite).toBe(false);
    expect(d.motivo).toBe("sem_autorizacao");
    expect(d.bloqueioPorAllowlist).toBe(true);
  });

  it("teste 6/7: contato autorizado dentro da janela → responde", () => {
    const d = decidirElegibilidade({
      ...base,
      modo: "allowlist",
      aiAuthorizedAt: new Date(AGORA.getTime() - 3 * DIA),
    });
    expect(d.permite).toBe(true);
    expect(d.motivo).toBe("autorizado");
  });

  it("submissão antiga (fora da janela) NÃO reativa a IA", () => {
    const d = decidirElegibilidade({
      ...base,
      modo: "allowlist",
      aiAuthorizedAt: new Date(AGORA.getTime() - 30 * DIA),
      ttlMs: 21 * DIA,
    });
    expect(d.permite).toBe(false);
    expect(d.motivo).toBe("autorizacao_expirada");
    expect(d.bloqueioPorAllowlist).toBe(true);
  });

  it("teste 10: conversa marcada human_only (force_human) → nunca responde, mesmo autorizada", () => {
    const d = decidirElegibilidade({
      ...base,
      modo: "allowlist",
      forceHuman: true,
      aiAuthorizedAt: new Date(AGORA.getTime() - DIA),
    });
    expect(d.permite).toBe(false);
    expect(d.motivo).toBe("force_human");
  });

  it("teste 2: conversa aberta e autorizada → responde (estado da conversa não pesa)", () => {
    const d = decidirElegibilidade({
      ...base,
      modo: "allowlist",
      assigneeKind: "ai",
      aiAuthorizedAt: new Date(AGORA.getTime() - DIA),
    });
    expect(d.permite).toBe(true);
  });
});

describe("decidirElegibilidade — pré-go-live", () => {
  it("permite o número escolhido mesmo sem autorização global", () => {
    const d = decidirElegibilidade({
      ...base,
      modo: "allowlist",
      preGoLiveAtivo: true,
      numeroDeTesteAutorizado: true,
      aiAuthorizedAt: null,
    });
    expect(d).toEqual({
      permite: true,
      motivo: "numero_de_teste",
      bloqueioPorAllowlist: false,
    });
  });

  it("barra quem está fora da lista mesmo que uma campanha já tenha autorizado", () => {
    const d = decidirElegibilidade({
      ...base,
      modo: "allowlist",
      preGoLiveAtivo: true,
      numeroDeTesteAutorizado: false,
      aiAuthorizedAt: AGORA,
    });
    expect(d).toEqual({
      permite: false,
      motivo: "fora_da_lista_de_teste",
      bloqueioPorAllowlist: true,
    });
  });

  it("vetos humanos continuam acima da lista de teste", () => {
    const d = decidirElegibilidade({
      ...base,
      modo: "allowlist",
      preGoLiveAtivo: true,
      numeroDeTesteAutorizado: true,
      forceHuman: true,
    });
    expect(d.motivo).toBe("force_human");
  });
});

describe("ttlDaAutorizacaoMs", () => {
  it("default quando ausente/vazio/inválido/zero/negativo", () => {
    const esperado = AI_ALLOWLIST_TTL_DAYS_DEFAULT * DIA;
    expect(ttlDaAutorizacaoMs({})).toBe(esperado);
    expect(ttlDaAutorizacaoMs({ AI_ALLOWLIST_TTL_DAYS: "" })).toBe(esperado);
    expect(ttlDaAutorizacaoMs({ AI_ALLOWLIST_TTL_DAYS: "abc" })).toBe(esperado);
    expect(ttlDaAutorizacaoMs({ AI_ALLOWLIST_TTL_DAYS: "0" })).toBe(esperado);
    expect(ttlDaAutorizacaoMs({ AI_ALLOWLIST_TTL_DAYS: "-5" })).toBe(esperado);
  });
  it("respeita o valor configurado", () => {
    expect(ttlDaAutorizacaoMs({ AI_ALLOWLIST_TTL_DAYS: "7" })).toBe(7 * DIA);
  });
});

describe("decidirElegibilidade — organização não operante vence tudo", () => {
  it.each(["suspended", "redacted", "archived", "status_que_ainda_nao_existe", null])(
    "orgStatus %s → nega com org_nao_operante, antes de force_human, silêncio, dono humano e allowlist",
    (orgStatus) => {
      const d = decidirElegibilidade({
        ...base,
        orgStatus,
        modo: "allowlist",
        forceHuman: true,
        botSilencedUntil: new Date(AGORA.getTime() + DIA),
        assigneeKind: "user",
        aiAuthorizedAt: AGORA,
      });
      expect(d).toEqual({ permite: false, motivo: "org_nao_operante", bloqueioPorAllowlist: false });
    },
  );

  it("org active não muda nada (controle): gate aberto segue permitindo", () => {
    expect(decidirElegibilidade({ ...base, orgStatus: "active" }).motivo).toBe("gate_aberto");
  });
});

describe("decidirElegibilidade — canal desativado vence tudo (menos org parada)", () => {
  it("canalDesativado nega com canal_desativado mesmo com gate aberto e sem nenhuma outra trava", () => {
    const d = decidirElegibilidade({ ...base, modo: "open", canalDesativado: true });
    expect(d).toEqual({ permite: false, motivo: "canal_desativado", bloqueioPorAllowlist: false });
  });

  it("canalDesativado vence force_human, silêncio, dono humano e allowlist", () => {
    const d = decidirElegibilidade({
      ...base,
      modo: "allowlist",
      canalDesativado: true,
      forceHuman: true,
      botSilencedUntil: new Date(AGORA.getTime() + DIA),
      assigneeKind: "user",
      aiAuthorizedAt: AGORA,
    });
    expect(d.motivo).toBe("canal_desativado");
  });

  it("org parada vence o canal (ordem declarada): org_nao_operante primeiro", () => {
    const d = decidirElegibilidade({ ...base, orgStatus: "suspended", canalDesativado: true });
    expect(d.motivo).toBe("org_nao_operante");
  });
});

describe("montarEstadoDeElegibilidade — a org viaja", () => {
  it("orgStatus ausente vira null, e null é não operante (falha fechada)", () => {
    const e = montarEstadoDeElegibilidade({
      aiGate: null,
      forceHuman: false,
      aiOptOut: false,
      assigneeKind: null,
      metadataDaConversa: null,
      botSilencedUntil: null,
      aiAuthorizedAt: null,
      orgStatus: undefined,
      agora: AGORA,
      ttlMs: DIA,
    });
    expect(e.orgStatus).toBeNull();
    expect(decidirElegibilidade(e).motivo).toBe("org_nao_operante");
  });

  it("canalDesativado ausente vira false (banco anterior à chave segue ligando)", () => {
    const e = montarEstadoDeElegibilidade({
      aiGate: "open",
      forceHuman: false,
      aiOptOut: false,
      assigneeKind: null,
      metadataDaConversa: null,
      botSilencedUntil: null,
      aiAuthorizedAt: null,
      orgStatus: "active",
      agora: AGORA,
      ttlMs: DIA,
    });
    expect(e.canalDesativado).toBe(false);
    expect(decidirElegibilidade(e).motivo).toBe("gate_aberto");
  });

  it("só o booleano true desliga; 'true' string e 1 não", () => {
    for (const cru of ["true", 1]) {
      const e = montarEstadoDeElegibilidade({
        aiGate: "open",
        forceHuman: false,
        aiOptOut: false,
        assigneeKind: null,
        metadataDaConversa: null,
        botSilencedUntil: null,
        aiAuthorizedAt: null,
        orgStatus: "active",
        canalDesativado: cru,
        agora: AGORA,
        ttlMs: DIA,
      });
      expect(e.canalDesativado).toBe(false);
    }
    const ligado = montarEstadoDeElegibilidade({
      aiGate: "open",
      forceHuman: false,
      aiOptOut: false,
      assigneeKind: null,
      metadataDaConversa: null,
      botSilencedUntil: null,
      aiAuthorizedAt: null,
      orgStatus: "active",
      canalDesativado: true,
      agora: AGORA,
      ttlMs: DIA,
    });
    expect(decidirElegibilidade(ligado).motivo).toBe("canal_desativado");
  });
});

describe("#2353 · contato interno não é atendido pela IA", () => {
  it("contato interno → NÃO responde, com motivo 'contato_interno' e sem bloqueio por allowlist", () => {
    const d = decidirElegibilidade({ ...base, modo: "open", contatoInterno: true });
    expect(d).toEqual({ permite: false, motivo: "contato_interno", bloqueioPorAllowlist: false });
  });

  it("o veto vale com o gate ABERTO (não é exigência do allowlist): é veto de contato", () => {
    // O caso da issue: o robô está ligado no número; quem não pode ser atendido
    // é a equipe, o sócio, a família — não uma questão de autorização positiva.
    expect(decidirElegibilidade({ ...base, modo: "open", contatoInterno: true }).motivo).toBe(
      "contato_interno",
    );
  });

  it("como 'Assumir' (conversa_de_humano), o bloqueioPorAllowlist é false: não gasta job nem vira erro", () => {
    const interno = decidirElegibilidade({ ...base, modo: "allowlist", contatoInterno: true });
    const humano = decidirElegibilidade({ ...base, modo: "allowlist", assigneeKind: "user" });
    expect(interno.bloqueioPorAllowlist).toBe(humano.bloqueioPorAllowlist);
    expect(interno.bloqueioPorAllowlist).toBe(false);
  });

  it("ordem declarada: um veto mais duro (force_human) vence o contato interno", () => {
    const d = decidirElegibilidade({ ...base, modo: "open", contatoInterno: true, forceHuman: true });
    expect(d.motivo).toBe("force_human");
  });

  it("regressão: contato SEM a tag segue sendo atendido com o gate aberto", () => {
    const d = decidirElegibilidade({ ...base, modo: "open", contatoInterno: false });
    expect(d).toEqual({ permite: true, motivo: "gate_aberto", bloqueioPorAllowlist: false });
  });

  it("montarEstadoDeElegibilidade: a tag interna cruza com settings.crm.internal_contact_tags", () => {
    const comTag = montarEstadoDeElegibilidade({
      aiGate: "open",
      forceHuman: false,
      aiOptOut: false,
      assigneeKind: null,
      metadataDaConversa: null,
      botSilencedUntil: null,
      aiAuthorizedAt: null,
      orgStatus: "active",
      contactTags: [" Interno "],
      orgSettings: { crm: { internal_contact_tags: ["interno"] } },
      agora: AGORA,
      ttlMs: DIA,
    });
    expect(comTag.contatoInterno).toBe(true);

    const semLista = montarEstadoDeElegibilidade({
      aiGate: "open",
      forceHuman: false,
      aiOptOut: false,
      assigneeKind: null,
      metadataDaConversa: null,
      botSilencedUntil: null,
      aiAuthorizedAt: null,
      orgStatus: "active",
      contactTags: ["interno"],
      orgSettings: {},
      agora: AGORA,
      ttlMs: DIA,
    });
    expect(semLista.contatoInterno).toBe(false);
  });
});

/**
 * #3974 — A OPÇÃO DO FLUXO NÃO ACORDA A IA.
 *
 * O follow-up de etapa ganhou, por fluxo, a opção de sair mesmo com a conversa
 * atribuída a uma pessoa. Ela vale para o follow-up PROGRAMADO; o turno da IA
 * responde pela MESMA régua de antes. Estes casos são a trava disso: com dono
 * (e calado ou não), a elegibilidade continua negando.
 */
describe("#3974 — conversa com dono: a IA continua barrada", () => {
  it("dono + silêncio infinito (assumir/atribuir) → conversa_silenciada", () => {
    const d = decidirElegibilidade({
      ...base,
      assigneeKind: "user",
      botSilencedUntil: Infinity,
    });
    expect(d.permite).toBe(false);
    expect(d.motivo).toBe("conversa_silenciada");
  });

  it("dono sem silêncio (atribuição de rodízio) → conversa_de_humano", () => {
    const d = decidirElegibilidade({ ...base, assigneeKind: "user", botSilencedUntil: null });
    expect(d.permite).toBe(false);
    expect(d.motivo).toBe("conversa_de_humano");
  });
});
