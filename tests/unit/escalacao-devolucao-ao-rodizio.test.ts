import { describe, expect, it } from "vitest";

import {
  avaliarEntregaAoRodizio,
  CHAVE_DA_DEVOLUCAO_AO_RODIZIO,
  contarDevolucoesAoRodizio,
  filtrarCandidatosExcluidos,
  houveRespostaHumanaDepoisDaEntrega,
  JANELA_DE_ENTREGA_RECENTE_MINUTOS,
  JANELA_DE_EXCLUSAO_MINUTOS,
  lerMarcasDeDevolucaoAoRodizio,
  lerPrazoDeDevolucaoAoRodizioMinutos,
  MAX_DEVOLUCOES_AO_RODIZIO,
  pessoaExcluidaDoRodizio,
  registrarDevolucaoAoRodizio,
  selecionarCandidatasAoRodizio,
  type ConversaEntregueAoRodizio,
} from "@/lib/escalacao/devolucao-ao-rodizio";

/**
 * A CONVERSA QUE O RODÍZIO ENTREGOU E NINGUÉM RESPONDEU VOLTA PARA A FILA — E A
 * PESSOA FICA FORA DELA POR 24 H.
 *
 * O que este arquivo guarda, na ordem em que custou:
 *
 *   1. Desligado (`null`) nada muda: organização sem o prazo não tem candidata
 *      nenhuma — o comportamento de quem já instalou.
 *   2. Só a conversa cujo ÚLTIMO evento de atribuição veio do RODÍZIO
 *      (`reason = 'routing'`) entra. Quem assumiu à mão, quem foi transferido e
 *      quem foi liberado ficam de fora: não foi o rodízio que entregou.
 *   3. O relógio conta da ENTREGA, e basta UMA mensagem humana depois dela para
 *      cancelar a devolução — `user` (inbox) ou `external_device` (celular).
 *   4. A EXCLUSÃO DE 24 H é o que faz a devolução servir: sem ela o rodízio
 *      reentregaria a mesma conversa à mesma pessoa no tick seguinte.
 *      `filtrarCandidatosExcluidos` é o corte, e é ele que o rodízio chama.
 *   5. Duas devoluções e a conversa sai do ciclo.
 */

const ORG = "22222222-2222-4222-8222-222222222222";
const PESSOA_A = "11111111-1111-4111-8111-111111111111";
const PESSOA_B = "99999999-9999-4999-8999-999999999999";
const AGORA = Date.parse("2026-10-16T15:00:00Z");
const min = (n: number) => new Date(AGORA - n * 60_000).toISOString();

function conversa(sobrescreve: Partial<ConversaEntregueAoRodizio> = {}): ConversaEntregueAoRodizio {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    organization_id: ORG,
    status: "claimed",
    assigned_to_user_id: PESSOA_A,
    metadata: {},
    ultimoEventoMotivo: "routing",
    entregueEm: min(90),
    ...sobrescreve,
  };
}

const selecao = (prazo: number | null = 60) => ({
  prazoPorOrg: new Map(prazo === null ? [] : [[ORG, prazo]]),
  agoraMs: AGORA,
});

describe("lerPrazoDeDevolucaoAoRodizioMinutos — o knob no jsonb", () => {
  it("ausente, nulo, fora da faixa ou de tipo errado é 'nunca'", () => {
    expect(lerPrazoDeDevolucaoAoRodizioMinutos(null)).toBeNull();
    expect(lerPrazoDeDevolucaoAoRodizioMinutos({})).toBeNull();
    expect(lerPrazoDeDevolucaoAoRodizioMinutos({ routing: {} })).toBeNull();
    expect(lerPrazoDeDevolucaoAoRodizioMinutos({ routing: { unanswered_return_minutes: null } })).toBeNull();
    expect(lerPrazoDeDevolucaoAoRodizioMinutos({ routing: { unanswered_return_minutes: "60" } })).toBeNull();
    expect(lerPrazoDeDevolucaoAoRodizioMinutos({ routing: { unanswered_return_minutes: 2 } })).toBeNull();
    expect(lerPrazoDeDevolucaoAoRodizioMinutos({ routing: { unanswered_return_minutes: 100_000 } })).toBeNull();
  });

  it("dentro da faixa devolve o inteiro — a MESMA faixa da devolução ao agente", () => {
    expect(lerPrazoDeDevolucaoAoRodizioMinutos({ routing: { unanswered_return_minutes: 5 } })).toBe(5);
    expect(lerPrazoDeDevolucaoAoRodizioMinutos({ routing: { unanswered_return_minutes: 60 } })).toBe(60);
    expect(lerPrazoDeDevolucaoAoRodizioMinutos({ routing: { unanswered_return_minutes: 1440 } })).toBe(1440);
  });

  it("não se confunde com o knob irmão, no mesmo objeto routing", () => {
    const settings = { routing: { handoff_return_after_minutes: 30 } };
    expect(lerPrazoDeDevolucaoAoRodizioMinutos(settings)).toBeNull();
  });
});

describe("avaliarEntregaAoRodizio — quem vence, e por quê", () => {
  it("entregue pelo rodízio há mais que o prazo, sem dono trocado: candidata", () => {
    expect(avaliarEntregaAoRodizio(conversa({ entregueEm: min(61) }), selecao(60))).toEqual({
      candidata: true,
      minutos: 60,
      entregueEm: min(61),
    });
  });

  it("regra DESLIGADA (prazo null): nada muda — sem candidata", () => {
    expect(avaliarEntregaAoRodizio(conversa({ entregueEm: min(500) }), selecao(null))).toEqual({
      candidata: false,
      motivo: "sem_prazo",
    });
  });

  it("dentro do prazo: não devolve — inclusive no minuto exato anterior", () => {
    expect(avaliarEntregaAoRodizio(conversa({ entregueEm: min(59) }), selecao(60))).toEqual({
      candidata: false,
      motivo: "dentro_do_prazo",
    });
  });

  it("o ÚLTIMO evento de atribuição não veio do rodízio: fica de fora", () => {
    for (const motivo of ["claim", "transfer", "release", null]) {
      expect(avaliarEntregaAoRodizio(conversa({ ultimoEventoMotivo: motivo }), selecao(60))).toEqual({
        candidata: false,
        motivo: "ultimo_evento_nao_e_rodizio",
      });
    }
  });

  it("sem dono não há entrega a desfazer: a devolução já aconteceu", () => {
    expect(avaliarEntregaAoRodizio(conversa({ assigned_to_user_id: null }), selecao(60))).toEqual({
      candidata: false,
      motivo: "sem_dono",
    });
  });

  it("conversa encerrada não é devolvida", () => {
    expect(avaliarEntregaAoRodizio(conversa({ status: "closed" }), selecao(60))).toEqual({
      candidata: false,
      motivo: "status_nao_devolvivel",
    });
  });

  it("duas devoluções já feitas: a conversa sai do ciclo", () => {
    const metadata = registrarDevolucaoAoRodizio(
      registrarDevolucaoAoRodizio({}, PESSOA_A, AGORA - 120 * 60_000),
      PESSOA_B,
      AGORA - 60 * 60_000,
    );
    expect(contarDevolucoesAoRodizio(metadata)).toBe(MAX_DEVOLUCOES_AO_RODIZIO);
    expect(avaliarEntregaAoRodizio(conversa({ metadata }), selecao(60))).toEqual({
      candidata: false,
      motivo: "ciclos_esgotados",
    });
  });

  it("sem relógio de entrega: não devolve às cegas", () => {
    expect(avaliarEntregaAoRodizio(conversa({ entregueEm: null }), selecao(60))).toEqual({
      candidata: false,
      motivo: "sem_entrega",
    });
  });

  /**
   * A TRAVA DAS 3 HORAS (promessa da #2985). Ligar o prazo numa instalação que
   * já roda não pode devolver de uma vez o estoque de conversas entregues em
   * dias anteriores — só o plantão de agora.
   */
  it("só entra entrega das últimas 3 horas: estoque antigo fica fora por 'entrega_antiga'", () => {
    // Dentro da janela (2 h 59), passado o prazo de 60: devolve.
    expect(avaliarEntregaAoRodizio(conversa({ entregueEm: min(179) }), selecao(60))).toEqual({
      candidata: true,
      minutos: 60,
      entregueEm: min(179),
    });
    // Exatamente no limite da janela: ainda é o plantão de agora.
    expect(avaliarEntregaAoRodizio(conversa({ entregueEm: min(180) }), selecao(60))).toMatchObject({
      candidata: true,
    });
    // Um minuto depois do limite: estoque antigo, e o motivo é OUTRO.
    expect(avaliarEntregaAoRodizio(conversa({ entregueEm: min(181) }), selecao(60))).toEqual({
      candidata: false,
      motivo: "entrega_antiga",
    });
    // Semanas depois de a pessoa ligar o prazo: nada de redistribuir o passado.
    expect(avaliarEntregaAoRodizio(conversa({ entregueEm: min(60 * 24 * 30) }), selecao(60))).toEqual({
      candidata: false,
      motivo: "entrega_antiga",
    });
  });

  it("prazo acima de 3 h nunca dispara — quando vence, a entrega já é estoque antigo", () => {
    // Com 240 min de prazo, a conversa só "venceria" aos 240 — idade em que já
    // saiu da janela de 3 h. Documentado, porque é consequência da trava.
    expect(avaliarEntregaAoRodizio(conversa({ entregueEm: min(120) }), selecao(240))).toEqual({
      candidata: false,
      motivo: "dentro_do_prazo",
    });
    expect(avaliarEntregaAoRodizio(conversa({ entregueEm: min(241) }), selecao(240))).toEqual({
      candidata: false,
      motivo: "entrega_antiga",
    });
    // A regra em uma linha: nenhuma idade de entrega faz o prazo de 240 disparar.
    const idades = Array.from({ length: 61 }, (_, i) => i * 5);
    for (const idade of idades) {
      const r = avaliarEntregaAoRodizio(conversa({ entregueEm: min(idade) }), selecao(240));
      expect(r).toMatchObject({ candidata: false });
    }
  });

  it("a trava é a MESMA da constante: 3 horas", () => {
    expect(JANELA_DE_ENTREGA_RECENTE_MINUTOS).toBe(180);
  });
});

describe("houveRespostaHumanaDepoisDaEntrega — a metade das mensagens", () => {
  it("mensagem ANTES da entrega não conta: a conversa é devolvida", () => {
    expect(houveRespostaHumanaDepoisDaEntrega(min(90), min(120))).toBe(false);
    expect(houveRespostaHumanaDepoisDaEntrega(min(90), null)).toBe(false);
  });

  it("qualquer mensagem humana DEPOIS da entrega cancela a devolução", () => {
    expect(houveRespostaHumanaDepoisDaEntrega(min(90), min(10))).toBe(true);
  });

  it("carimbo ilegível erra para 'respondeu': a conversa fica com a pessoa", () => {
    expect(houveRespostaHumanaDepoisDaEntrega("não é data", min(10))).toBe(true);
  });
});

describe("a exclusão de 24 h — o rodízio respeita, e é isso que faz servir", () => {
  it("a pessoa devolvida sai da lista de candidatos do rodízio", () => {
    const metadata = registrarDevolucaoAoRodizio({}, PESSOA_A, AGORA);
    const candidatos = [{ userId: PESSOA_A }, { userId: PESSOA_B }];
    expect(filtrarCandidatosExcluidos(candidatos, metadata, AGORA).map((c) => c.userId)).toEqual([PESSOA_B]);
    expect(pessoaExcluidaDoRodizio(metadata, PESSOA_A, AGORA)).toBe(true);
    expect(pessoaExcluidaDoRodizio(metadata, PESSOA_B, AGORA)).toBe(false);
  });

  it("a janela é de 24 h: antes dela a pessoa continua fora, depois volta", () => {
    const metadata = registrarDevolucaoAoRodizio({}, PESSOA_A, AGORA);
    const ateMs = AGORA + JANELA_DE_EXCLUSAO_MINUTOS * 60_000;
    expect(pessoaExcluidaDoRodizio(metadata, PESSOA_A, ateMs - 1)).toBe(true);
    expect(pessoaExcluidaDoRodizio(metadata, PESSOA_A, ateMs + 1)).toBe(false);
    expect(filtrarCandidatosExcluidos([{ userId: PESSOA_A }], metadata, ateMs + 1)).toHaveLength(1);
  });

  it("sem marca, ou com metadata lixo, ninguém é excluído — o rodízio segue igual", () => {
    const candidatos = [{ userId: PESSOA_A }, { userId: PESSOA_B }];
    for (const metadata of [null, undefined, {}, "texto", 42, [], { outro: true }]) {
      expect(filtrarCandidatosExcluidos(candidatos, metadata, AGORA)).toHaveLength(2);
    }
  });

  it("exclusão malformada ou sem prazo legível não exclui ninguém", () => {
    const metadata = {
      [CHAVE_DA_DEVOLUCAO_AO_RODIZIO]: {
        devolucoes: 1,
        exclusoes: [{ user_id: PESSOA_A }, { ate: min(-30) }, null, "x", { user_id: 42, ate: min(-10) }],
      },
    };
    expect(pessoaExcluidaDoRodizio(metadata, PESSOA_A, AGORA)).toBe(false);
    expect(filtrarCandidatosExcluidos([{ userId: PESSOA_A }], metadata, AGORA)).toHaveLength(1);
  });
});

describe("registrarDevolucaoAoRodizio — a marca que o cron grava", () => {
  it("conta a devolução e põe a pessoa fora por 24 h, preservando o resto do metadata", () => {
    const metadata = registrarDevolucaoAoRodizio({ outra_chave: "fica" }, PESSOA_A, AGORA);
    expect(metadata.outra_chave).toBe("fica");
    const marcas = lerMarcasDeDevolucaoAoRodizio(metadata);
    expect(marcas.devolucoes).toBe(1);
    expect(marcas.exclusoes).toEqual([
      { user_id: PESSOA_A, ate: new Date(AGORA + JANELA_DE_EXCLUSAO_MINUTOS * 60_000).toISOString() },
    ]);
  });

  it("a segunda devolução soma, e as exclusões vencidas são podadas", () => {
    const primeira = registrarDevolucaoAoRodizio({}, PESSOA_A, AGORA - 48 * 60 * 60_000);
    const segunda = registrarDevolucaoAoRodizio(primeira, PESSOA_B, AGORA);
    const marcas = lerMarcasDeDevolucaoAoRodizio(segunda);
    expect(marcas.devolucoes).toBe(2);
    // A exclusão de A venceu há muito: não fica no jsonb para sempre.
    expect(marcas.exclusoes.map((e) => e.user_id)).toEqual([PESSOA_B]);
  });

  it("devolver de novo a MESMA pessoa renova a janela em vez de duplicar a entrada", () => {
    const primeira = registrarDevolucaoAoRodizio({}, PESSOA_A, AGORA - 60_000);
    const segunda = registrarDevolucaoAoRodizio(primeira, PESSOA_A, AGORA);
    const marcas = lerMarcasDeDevolucaoAoRodizio(segunda);
    expect(marcas.exclusoes).toHaveLength(1);
    expect(marcas.exclusoes[0]?.ate).toBe(
      new Date(AGORA + JANELA_DE_EXCLUSAO_MINUTOS * 60_000).toISOString(),
    );
  });
});

describe("selecionarCandidatasAoRodizio — o lote", () => {
  it("devolve só quem passou no portão, cada uma com o prazo da própria entrega", () => {
    const OUTRA = "55555555-5555-4555-8555-555555555555";
    const sel = {
      prazoPorOrg: new Map([
        [ORG, 60],
        [OUTRA, 15],
      ]),
      agoraMs: AGORA,
    };
    const lote = [
      conversa({ id: "a", entregueEm: min(61) }),
      conversa({ id: "b", entregueEm: min(30) }),
      conversa({ id: "c", organization_id: OUTRA, entregueEm: min(16) }),
      conversa({ id: "d", ultimoEventoMotivo: "claim", entregueEm: min(900) }),
    ];
    expect(selecionarCandidatasAoRodizio(lote, sel).map((v) => [v.conversa.id, v.minutos])).toEqual([
      ["a", 60],
      ["c", 15],
    ]);
  });
});

describe("o fluxo inteiro, no nível da regra: entregue pelo rodízio, sem resposta, volta", () => {
  it("desligado nada muda; ligado devolve e a pessoa fica fora por 24 h", () => {
    const entregue = conversa({ entregueEm: min(90) });

    // DESLIGADO: a mesma conversa não tem candidata nenhuma.
    expect(avaliarEntregaAoRodizio(entregue, selecao(null)).candidata).toBe(false);

    // LIGADO, com resposta humana depois da entrega: continua com a pessoa.
    const portao = avaliarEntregaAoRodizio(entregue, selecao(60));
    expect(portao.candidata).toBe(true);
    if (!portao.candidata) throw new Error("a conversa deveria passar no portão");
    expect(houveRespostaHumanaDepoisDaEntrega(portao.entregueEm, min(5))).toBe(true);

    // LIGADO, sem NENHUMA mensagem humana: devolve, e o rodízio passa a excluir.
    expect(houveRespostaHumanaDepoisDaEntrega(portao.entregueEm, null)).toBe(false);
    const metadata = registrarDevolucaoAoRodizio(entregue.metadata, PESSOA_A, AGORA);
    expect(filtrarCandidatosExcluidos([{ userId: PESSOA_A }], metadata, AGORA)).toEqual([]);
  });
});
