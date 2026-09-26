/**
 * O ESTADO DE CADA TAREFA DO JEV — a regra que o worker, a rota e o cartão
 * obedecem. A ordem do cabeçalho de `./tarefas.ts` é o que se prova aqui, com
 * uma tarefa de mentira para os casos que o clima sozinho não alcança (tarefa
 * nova, alcance maior que o aceite).
 */
import { describe, expect, it } from "vitest";

import { idDaTarefaSchema, lerConfigDoJev, type ConfigDoJev } from "@/lib/ai/decisao/config";
import {
  algumRoteadorQuePergunta,
  estadoAoLigar,
  estadoEfetivoDaTarefa,
  estadoGravadoDaTarefa,
  TAREFA_DA_MANIPULACAO,
  TAREFA_DO_CLIMA,
  TAREFAS_DO_JEV,
  tarefaEhNova,
  tarefaSemCamada,
  tarefaSemRoteador,
  TAREFA_DO_ROTEADOR,
  MEMBROS_NO_MAXIMO,
} from "@/lib/ai/decisao/tarefas";
import { CONFERENCIA_DE_ENTRADA, CONFERENCIAS_DE_SAIDA } from "@/lib/ai/guardrails/lista-de-conferencia";
import { PONTOS_DE_IA } from "@/lib/ai/pontos/registro";

const ADMIN = "22222222-2222-4222-8222-222222222222";
const ACEITE = { em: "2026-09-23T12:00:00.000Z", por: ADMIN };
const QUANDO = { alterado_em: "2026-09-24T12:00:00.000Z", alterado_por: ADMIN };

/** Uma tarefa que ainda não existe, só com o que a regra lê. */
const NOVA_DA_MENSAGEM = { id: "futura", alcance: "mensagem" } as const;
const NOVA_DA_CONVERSA = { id: "futura_da_conversa", alcance: "conversa" } as const;

function config(jev: unknown): ConfigDoJev {
  return lerConfigDoJev({ jev });
}

describe("TAREFAS_DO_JEV", () => {
  it("uma chave gravável por tarefa, e uma tarefa por chave", () => {
    expect(TAREFAS_DO_JEV.map((t) => t.id).sort()).toEqual([...idDaTarefaSchema.options].sort());
  });

  /**
   * O sentido inverso do caso abaixo. Um ponto marcado com `decisaoRapida`, com
   * chamador, e sem tarefa passava todos os gates: `chaveDaOrganizacao` devolve
   * `null` em silêncio para ponto sem tarefa, e a tela (que deriva desta lista)
   * não o mostra — um chamador que nunca dispara, sem log.
   */
  it("todo ponto marcado como decisão rápida tem uma tarefa do Jev", () => {
    const pontosComTarefa = new Set(TAREFAS_DO_JEV.flatMap((t) => (t.ponto ? [t.ponto] : [])));
    const marcados = PONTOS_DE_IA.filter((p) => p.decisaoRapida !== undefined);
    expect(marcados.length, "a varredura enxerga os pontos marcados").toBeGreaterThan(0);
    expect(marcados.filter((p) => !pontosComTarefa.has(p.id)).map((p) => p.id)).toEqual([]);
  });

  it("a tarefa com ponto fala o que o registro fala, na primitiva que o registro declara", () => {
    const divergentes = TAREFAS_DO_JEV.flatMap((t) => {
      if (!t.ponto) return [];
      const p = PONTOS_DE_IA.find((x) => x.id === t.ponto);
      const igual =
        p?.decisaoRapida !== undefined &&
        p.decisaoRapida.primitiva === t.primitiva &&
        p.decisaoRapida.oQueOJevFaz === t.oQueFaz;
      return igual ? [] : [t.id];
    });
    expect(divergentes).toEqual([]);
  });

  it("a camada que a tarefa acompanha é a da verificação do MESMO ponto na Segurança", () => {
    const conferencias = [CONFERENCIA_DE_ENTRADA, ...CONFERENCIAS_DE_SAIDA];
    const comCamada = TAREFAS_DO_JEV.filter((t) => t.camada !== undefined);
    expect(comCamada.map((t) => t.id)).toEqual([TAREFA_DA_MANIPULACAO.id]);
    expect(
      comCamada.filter((t) => conferencias.find((c) => c.nome === t.ponto)?.camada !== t.camada).map((t) => t.id),
    ).toEqual([]);
  });

  it("tarefaSemCamada: só a camada desligada para a organização para a tarefa", () => {
    const ligadas = { jailbreak: true, promessa_semantica: false };
    const semManipulacao = { jailbreak: false, promessa_semantica: true };
    expect(tarefaSemCamada(TAREFA_DA_MANIPULACAO, ligadas)).toBe(false);
    expect(tarefaSemCamada(TAREFA_DA_MANIPULACAO, semManipulacao)).toBe(true);
    // O clima não acompanha camada nenhuma.
    expect(tarefaSemCamada(TAREFA_DO_CLIMA, semManipulacao)).toBe(false);
  });
});

describe("estadoEfetivoDaTarefa", () => {
  it("interruptor mestre desligado ⇒ toda tarefa desligada, qualquer que seja o gravado", () => {
    const c = config({ ligado: false, modo: "decide", aceite: ACEITE, tarefas: { clima: { estado: "decidindo" } } });
    expect(estadoEfetivoDaTarefa(c, TAREFA_DO_CLIMA)).toBe("desligada");
    expect(estadoEfetivoDaTarefa(c, NOVA_DA_MENSAGEM)).toBe("desligada");
  });

  it("ligado sem aceite é desligado (a leitura já recusa)", () => {
    expect(estadoEfetivoDaTarefa(config({ ligado: true }), TAREFA_DO_CLIMA)).toBe("desligada");
  });

  it("clima sem estado gravado ⇒ o `modo` da onda 1, sem reescrever nada", () => {
    expect(estadoEfetivoDaTarefa(config({ ligado: true, modo: "observacao", aceite: ACEITE }), TAREFA_DO_CLIMA)).toBe(
      "observando",
    );
    expect(estadoEfetivoDaTarefa(config({ ligado: true, modo: "decide", aceite: ACEITE }), TAREFA_DO_CLIMA)).toBe(
      "decidindo",
    );
  });

  it("o estado gravado da tarefa vence o `modo`", () => {
    const c = config({ ligado: true, modo: "decide", aceite: ACEITE, tarefas: { clima: { estado: "desligada", ...QUANDO } } });
    expect(estadoEfetivoDaTarefa(c, TAREFA_DO_CLIMA)).toBe("desligada");
  });

  /**
   * Ilegível não é ausente. Ausente, a tarefa nova começaria observando
   * sozinha (R7) e o clima seguiria o `modo` — e um estado que uma versão mais
   * nova gravou (e esta não lê) voltaria a mandar mensagem para fora depois de
   * um rollback, mesmo que lá ele quisesse dizer "desligada". Para TODA tarefa.
   */
  it.each(TAREFAS_DO_JEV.map((t) => [t.id, t] as const))(
    "%s com valor ilegível ⇒ desligada, sem selo Novo, e o resto da config segue de pé",
    (id, tarefa) => {
      const c = config({ ligado: true, modo: "decide", aceite: ACEITE, tarefas: { [id]: { estado: "turbo" } } });
      expect(c.ligado).toBe(true);
      expect(estadoEfetivoDaTarefa(c, tarefa)).toBe("desligada");
      expect(tarefaEhNova(c, tarefa)).toBe(false);
    },
  );

  it("tarefa nova de alcance 'mensagem' começa observando sozinha (DEC-012 #3), com o selo Novo", () => {
    const c = config({ ligado: true, modo: "decide", aceite: ACEITE });
    expect(estadoEfetivoDaTarefa(c, NOVA_DA_MENSAGEM)).toBe("observando");
    expect(tarefaEhNova(c, NOVA_DA_MENSAGEM)).toBe(true);
  });

  it("tarefa nova nunca herda o `modo`: o clima decidindo não faz a nova decidir", () => {
    const c = config({ ligado: true, modo: "decide", aceite: ACEITE, tarefas: { clima: { estado: "decidindo" } } });
    expect(estadoEfetivoDaTarefa(c, NOVA_DA_MENSAGEM)).toBe("observando");
  });

  it("tarefa que pede a conversa, com o aceite de 'cada mensagem', fica desligada — mesmo gravada decidindo", () => {
    const semAlcance = config({ ligado: true, aceite: ACEITE });
    const comAlcance = config({ ligado: true, aceite: { ...ACEITE, alcance: "mensagem" } });
    for (const c of [semAlcance, comAlcance]) {
      expect(estadoEfetivoDaTarefa(c, NOVA_DA_CONVERSA)).toBe("desligada");
      expect(tarefaEhNova(c, NOVA_DA_CONVERSA)).toBe(false);
    }
    const gravadaDecidindo: ConfigDoJev = { ...comAlcance, tarefas: { clima: { estado: "decidindo" } } };
    const naConversa = { ...NOVA_DA_CONVERSA, id: "clima" };
    expect(estadoEfetivoDaTarefa(gravadaDecidindo, naConversa), "falha fechada pelo alcance").toBe("desligada");
  });

  it("com o aceite da conversa, a tarefa da conversa vale o gravado — mas nunca começa sozinha", () => {
    const c = config({ ligado: true, aceite: { ...ACEITE, alcance: "conversa", versao: 2 } });
    expect(estadoEfetivoDaTarefa(c, NOVA_DA_CONVERSA)).toBe("desligada");
    const gravada: ConfigDoJev = { ...c, tarefas: { clima: { estado: "observando" } } };
    expect(estadoEfetivoDaTarefa(gravada, { ...NOVA_DA_CONVERSA, id: "clima" })).toBe("observando");
  });

  it("aceite com alcance desconhecido é aceite nenhum: tudo desligado", () => {
    const c = config({ ligado: true, aceite: { ...ACEITE, alcance: "tudo" } });
    expect(c.ligado).toBe(false);
    expect(estadoEfetivoDaTarefa(c, TAREFA_DO_CLIMA)).toBe("desligada");
  });
});

describe("estadoAoLigar — o que o 'pronto para ligar' promete", () => {
  it("com o Jev desligado, é o estado gravado: o clima desligado volta desligado, e não pelo `modo`", () => {
    expect(estadoAoLigar(config({ ligado: false, modo: "decide", aceite: ACEITE }), TAREFA_DO_CLIMA)).toBe("decidindo");
    const climaDesligado = config({ ligado: false, modo: "decide", aceite: ACEITE, tarefas: { clima: { estado: "desligada" } } });
    expect(estadoAoLigar(climaDesligado, TAREFA_DO_CLIMA)).toBe("desligada");
  });

  it("sem aceite ainda, vale o aceite que a tela pede — cada mensagem, sozinha", () => {
    expect(estadoAoLigar(config({}), TAREFA_DO_CLIMA)).toBe("observando");
    expect(estadoAoLigar(config({}), NOVA_DA_MENSAGEM)).toBe("observando");
    expect(estadoAoLigar(config({}), NOVA_DA_CONVERSA), "falha fechada pelo alcance").toBe("desligada");
  });

  it("ligado, é o estado efetivo", () => {
    const c = config({ ligado: true, aceite: ACEITE, tarefas: { clima: { estado: "decidindo", ...QUANDO } } });
    expect(estadoAoLigar(c, TAREFA_DO_CLIMA)).toBe(estadoEfetivoDaTarefa(c, TAREFA_DO_CLIMA));
  });
});

describe("tarefaEhNova / estadoGravadoDaTarefa", () => {
  it("o clima nunca é novo: o `modo` já é a escolha dele", () => {
    expect(tarefaEhNova(config({ ligado: true, aceite: ACEITE }), TAREFA_DO_CLIMA)).toBe(false);
    expect(estadoGravadoDaTarefa(config({ ligado: true, aceite: ACEITE }), "clima")).toBe("observando");
  });

  it("desligado não é novo — o selo só aparece em tarefa que está rodando", () => {
    expect(tarefaEhNova(config({ ligado: false, aceite: ACEITE }), NOVA_DA_MENSAGEM)).toBe(false);
  });

  it("tarefa sem nada gravado não tem estado escolhido", () => {
    expect(estadoGravadoDaTarefa(config({ ligado: true, aceite: ACEITE }), "futura")).toBeUndefined();
  });
});

/**
 * O roteador que o Jev pode perguntar: ativo E com 1 a 254 intenções. Antes,
 * `sem_roteador` só olhava `is_active`, e o roteador recém-criado (sem
 * intenção) deixava a tarefa "Só observa" esperando uma comparação que nunca vem.
 */
describe("o roteador que o Jev pode perguntar", () => {
  const com = (n: number) => ({ intencoes: [{ count: n }] });
  it("de 1 a MEMBROS_NO_MAXIMO intenções", () => {
    expect(algumRoteadorQuePergunta([com(0)])).toBe(false);
    expect(algumRoteadorQuePergunta([com(1)])).toBe(true);
    expect(algumRoteadorQuePergunta([com(MEMBROS_NO_MAXIMO)])).toBe(true);
    expect(algumRoteadorQuePergunta([com(MEMBROS_NO_MAXIMO + 1)])).toBe(false);
  });
  it("basta um; nenhum, ou a contagem ilegível, é não", () => {
    expect(algumRoteadorQuePergunta([com(0), com(3)])).toBe(true);
    expect(algumRoteadorQuePergunta([])).toBe(false);
    expect(algumRoteadorQuePergunta([{ intencoes: null }, { intencoes: [{ count: "2" }] }])).toBe(false);
  });
  it("só a tarefa do roteador depende dele", () => {
    expect(tarefaSemRoteador(TAREFA_DO_ROTEADOR, false)).toBe(true);
    expect(tarefaSemRoteador(TAREFA_DO_CLIMA, false)).toBe(false);
  });
});
