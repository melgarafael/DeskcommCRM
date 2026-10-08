import { describe, expect, it } from "vitest";

import {
  agendaRetorno,
  cancelaRetorno,
  listaRetornos,
  situacaoDoRetorno,
  statusDaPromessaNaFila,
  validaInstanteDoRetorno,
  type PayloadDoRetorno,
  type RetornoAgendado,
  type RetornoDb,
} from "./retorno";
import { resolveJanelaDeRetorno, RETORNO_MIN_AHEAD_MS_PADRAO } from "./janela";

/**
 * A REGRA do retorno, sem banco.
 *
 * O que estes testes guardam não é a fachada: é o COMPORTAMENTO que os dois
 * runtimes precisam compartilhar. Se amanhã alguém "simplificar" a validação de
 * janela do lado do Next e não do lado do motor, o mesmo horário passa a ser
 * aceito num caminho e recusado no outro — e o sintoma aparece semanas depois
 * como "o agente marcou um retorno que a tela dizia ser impossível".
 */

const AGORA = new Date("2026-08-04T12:00:00Z");
const JANELA = { minAheadMs: 30 * 60_000, maxAheadMs: 30 * 86_400_000, staggerWindowMs: 0 };
const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";

function retornoFake(over: Partial<RetornoAgendado> = {}): RetornoAgendado {
  return {
    id: "ret-1",
    contactId: CONTATO,
    quando: "2026-08-06T13:00:00.000Z",
    prometidoPara: "2026-08-06T13:00:00Z",
    situacao: "agendado",
    motivo: "reconfirmar a consulta",
    promessa: "confirmo com você na quarta",
    canceladoEm: null,
    motivoDoCancelamento: null,
    ...over,
  };
}

interface Espiao {
  db: RetornoDb;
  inseridos: Array<{ contactId: string; quando: Date; payload: PayloadDoRetorno }>;
  cancelados: string[];
}

function fakeDb(over: Partial<RetornoDb> = {}): Espiao {
  const inseridos: Espiao["inseridos"] = [];
  const cancelados: string[] = [];
  const db: RetornoDb = {
    buscaRetornoVivo: async () => null,
    insere: async (_orgId, input) => {
      inseridos.push({ contactId: input.contactId, quando: input.quando, payload: input.payload });
      return retornoFake({ quando: input.quando.toISOString() });
    },
    buscaPorId: async () => retornoFake(),
    marcaCancelado: async (_orgId, id) => {
      cancelados.push(id);
      return true;
    },
    lista: async () => [retornoFake()],
    ...over,
  };
  return { db, inseridos, cancelados };
}

describe("validaInstanteDoRetorno", () => {
  it("recusa data que não é ISO 8601", () => {
    const r = validaInstanteDoRetorno("amanhã de manhã", AGORA, JANELA);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("instante_invalido");
  });

  it("recusa instante no passado", () => {
    const r = validaInstanteDoRetorno("2026-08-04T11:59:00Z", AGORA, JANELA);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("instante_no_passado");
  });

  it("recusa cedo demais (dentro da antecedência mínima)", () => {
    // 29 min à frente, com mínimo de 30: o limite inferior é o que separa
    // "retorno" de "responder de novo agora", e é onde o off-by-one mora.
    const r = validaInstanteDoRetorno("2026-08-04T12:29:00Z", AGORA, JANELA);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("instante_fora_da_janela");
  });

  it("aceita EXATAMENTE na antecedência mínima", () => {
    const r = validaInstanteDoRetorno("2026-08-04T12:30:00Z", AGORA, JANELA);
    expect(r.ok).toBe(true);
  });

  it("aceita EXATAMENTE no horizonte máximo e recusa um minuto além", () => {
    const noLimite = new Date(AGORA.getTime() + JANELA.maxAheadMs).toISOString();
    expect(validaInstanteDoRetorno(noLimite, AGORA, JANELA).ok).toBe(true);

    const alem = new Date(AGORA.getTime() + JANELA.maxAheadMs + 60_000).toISOString();
    const r = validaInstanteDoRetorno(alem, AGORA, JANELA);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("instante_fora_da_janela");
  });
});

describe("agendaRetorno", () => {
  it("cria o retorno e leva motivo, promessa e instante ABSOLUTO no payload", async () => {
    const espiao = fakeDb();
    const r = await agendaRetorno(
      espiao.db,
      { agora: AGORA, janela: JANELA },
      { orgId: ORG, contactId: CONTATO },
      {
        motivo: "reconfirmar a consulta",
        prometidoPara: "2026-08-06T13:00:00Z",
        promessa: "confirmo com você na quarta",
      },
    );

    expect(r.ok).toBe(true);
    expect(espiao.inseridos).toHaveLength(1);
    const payload = espiao.inseridos[0]!.payload;
    // `promised_at` é o que o turno futuro lê para saber o que foi combinado.
    // Perdê-lo faria o agente reabrir a conversa sem lembrar da própria promessa.
    expect(payload.promised_at).toBe("2026-08-06T13:00:00Z");
    expect(payload.reason).toBe("reconfirmar a consulta");
    expect(payload.promise).toBe("confirmo com você na quarta");
  });

  it("NÃO cria um segundo retorno quando já existe um vivo", async () => {
    const existente = retornoFake({ id: "ret-existente" });
    const espiao = fakeDb({ buscaRetornoVivo: async () => existente });

    const r = await agendaRetorno(
      espiao.db,
      { agora: AGORA, janela: JANELA },
      { orgId: ORG, contactId: CONTATO },
      { motivo: "reconfirmar", prometidoPara: "2026-08-06T13:00:00Z", promessa: "volto quarta" },
    );

    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("esperava recusa");
    expect(r.codigo).toBe("ja_existe_retorno");
    expect(r.existente?.id).toBe("ret-existente");
    // O guard vale pelo que ele IMPEDE: sem esta asserção, uma implementação que
    // devolvesse a recusa E inserisse mesmo assim passaria.
    expect(espiao.inseridos).toHaveLength(0);
  });

  it("não consulta o banco quando o instante já é inválido", async () => {
    // A ordem importa: validar depois da consulta gastaria uma ida ao banco em
    // todo turno em que o modelo escreve "amanhã", que é o erro mais comum dele.
    let consultas = 0;
    const espiao = fakeDb({
      buscaRetornoVivo: async () => {
        consultas += 1;
        return null;
      },
    });
    await agendaRetorno(
      espiao.db,
      { agora: AGORA, janela: JANELA },
      { orgId: ORG, contactId: CONTATO },
      { motivo: "x", prometidoPara: "amanhã", promessa: "y" },
    );
    expect(consultas).toBe(0);
  });

  it("aplica o stagger: dois contatos no mesmo minuto não disparam juntos", async () => {
    const janelaComStagger = { ...JANELA, staggerWindowMs: 60_000 };
    const quandos: number[] = [];
    for (const contato of [CONTATO, "33333333-3333-4333-8333-333333333333"]) {
      const espiao = fakeDb();
      await agendaRetorno(
        espiao.db,
        { agora: AGORA, janela: janelaComStagger },
        { orgId: ORG, contactId: contato },
        { motivo: "x", prometidoPara: "2026-08-06T13:00:00Z", promessa: "y" },
      );
      quandos.push(espiao.inseridos[0]!.quando.getTime());
    }
    expect(quandos[0]).not.toBe(quandos[1]);
  });
});

describe("cancelaRetorno", () => {
  it("cancela um retorno agendado", async () => {
    const espiao = fakeDb();
    const r = await cancelaRetorno(
      espiao.db,
      { agora: AGORA },
      { orgId: ORG, retornoId: "ret-1" },
      { motivo: "o cliente respondeu" },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("esperava sucesso");
    expect(r.retorno.situacao).toBe("cancelado");
    expect(r.retorno.motivoDoCancelamento).toBe("o cliente respondeu");
    expect(espiao.cancelados).toEqual(["ret-1"]);
  });

  it("recusa cancelar um retorno que JÁ DISPAROU — e não escreve nada", async () => {
    // Reescrever o desfecho de um retorno que já aconteceu transformaria
    // histórico em ficção: a mensagem foi ao cliente, e a linha diria que não.
    const espiao = fakeDb({ buscaPorId: async () => retornoFake({ situacao: "disparado" }) });
    const r = await cancelaRetorno(
      espiao.db,
      { agora: AGORA },
      { orgId: ORG, retornoId: "ret-1" },
      { motivo: "tarde demais" },
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("esperava recusa");
    expect(r.codigo).toBe("ja_encerrado");
    expect(espiao.cancelados).toEqual([]);
  });

  it("perder a corrida para o disparo vira ja_encerrado, nunca sucesso", async () => {
    // O UPDATE condicional devolve 0 linhas quando o cron disparou entre a
    // leitura e a escrita. Responder "cancelado" ali faria a tela afirmar que o
    // cliente não vai receber a mensagem que ele JÁ recebeu.
    const espiao = fakeDb({ marcaCancelado: async () => false });
    const r = await cancelaRetorno(
      espiao.db,
      { agora: AGORA },
      { orgId: ORG, retornoId: "ret-1" },
      { motivo: "tentando" },
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("esperava recusa");
    expect(r.codigo).toBe("ja_encerrado");
  });

  it("retorno inexistente é nao_encontrado", async () => {
    const espiao = fakeDb({ buscaPorId: async () => null });
    const r = await cancelaRetorno(
      espiao.db,
      { agora: AGORA },
      { orgId: ORG, retornoId: "ret-1" },
      { motivo: "x" },
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("esperava recusa");
    expect(r.codigo).toBe("nao_encontrado");
  });
});

describe("situacaoDoRetorno", () => {
  it("distingue cancelado de disparado — que enabled=false sozinho não distingue", () => {
    expect(situacaoDoRetorno({ enabled: true, cancelled_at: null })).toBe("agendado");
    expect(situacaoDoRetorno({ enabled: false, cancelled_at: null })).toBe("disparado");
    expect(situacaoDoRetorno({ enabled: false, cancelled_at: "2026-08-04T12:00:00Z" })).toBe(
      "cancelado",
    );
  });

  it("enabled=false com last_error=org_nao_operante é NÃO disparado: o agente não pode dizer que o retorno saiu", () => {
    expect(
      situacaoDoRetorno({ enabled: false, cancelled_at: null, last_error: "org_nao_operante" }),
    ).toBe("nao_disparado");
    expect(situacaoDoRetorno({ enabled: false, cancelled_at: null, last_error: null })).toBe("disparado");
    expect(
      situacaoDoRetorno({ enabled: false, cancelled_at: "2026-08-04T12:00:00Z", last_error: "org_nao_operante" }),
    ).toBe("cancelado");
    expect(
      situacaoDoRetorno({ enabled: true, cancelled_at: null, last_error: "org_nao_operante" }),
    ).toBe("agendado");
  });
});

describe("listaRetornos", () => {
  it("limita o pedido a 100 e nunca a menos de 1", async () => {
    const limites: number[] = [];
    const espiao = fakeDb({
      lista: async (_o, _c, limite) => {
        limites.push(limite);
        return [];
      },
    });
    await listaRetornos(espiao.db, { orgId: ORG, contactId: CONTATO }, { limite: 5000 });
    await listaRetornos(espiao.db, { orgId: ORG, contactId: CONTATO }, { limite: 0 });
    expect(limites).toEqual([100, 1]);
  });
});

describe("resolveJanelaDeRetorno", () => {
  it("cai nos padrões quando a variável está ausente ou é lixo", () => {
    expect(resolveJanelaDeRetorno({}).minAheadMs).toBe(RETORNO_MIN_AHEAD_MS_PADRAO);
    expect(resolveJanelaDeRetorno({ FOLLOWUP_MIN_AHEAD_MS: "abc" }).minAheadMs).toBe(
      RETORNO_MIN_AHEAD_MS_PADRAO,
    );
  });

  it("respeita o valor configurado — é knob, não constante", () => {
    expect(resolveJanelaDeRetorno({ FOLLOWUP_MIN_AHEAD_MS: "600000" }).minAheadMs).toBe(600_000);
    // 0 é válido no stagger (desliga o espalhamento) e inválido nos demais.
    expect(resolveJanelaDeRetorno({ CRON_STAGGER_WINDOW_MS: "0" }).staggerWindowMs).toBe(0);
  });
});

describe("statusDaPromessaNaFila", () => {
  it("desligada pela parada da empresa NÃO é 'concluída'", () => {
    expect(statusDaPromessaNaFila({ enabled: false, cancelled_at: null, last_error: "org_nao_operante" })).toBe("não disparada");
  });
  it("disparada de verdade segue 'concluída'; cancelada e viva não mudam", () => {
    expect(statusDaPromessaNaFila({ enabled: false, cancelled_at: null, last_error: null })).toBe("concluída");
    expect(statusDaPromessaNaFila({ enabled: false, cancelled_at: "2026-01-01", last_error: "org_nao_operante" })).toBe("cancelada");
    expect(statusDaPromessaNaFila({ enabled: true, cancelled_at: null, last_error: "org_nao_operante" })).toBe("agendada");
  });
});
