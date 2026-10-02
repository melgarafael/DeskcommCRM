/**
 * O ESTADO DE CADA TAREFA DO JEV — a regra que o worker, a rota e o cartão
 * obedecem. A ordem do cabeçalho de `./tarefas.ts` é o que se prova aqui, com
 * uma tarefa de mentira para os casos que o clima sozinho não alcança (tarefa
 * nova, alcance maior que o aceite).
 */
import { describe, expect, it } from "vitest";

import { idDaTarefaSchema, lerConfigDoJev, type ConfigDoJev } from "@/lib/ai/decisao/config";
import {
  algumFluxoQueClassifica,
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
  PEDIDOS_DO_CLIENTE,
  rotuloDaChamadaDoJev,
  TAREFA_DO_PEDIDO_DE_HUMANO,
  TAREFA_DO_PEDIDO_PARA_PARAR,
  TAREFA_DO_FOLLOWUP,
  tarefaPodeDecidir,
  tarefaSemFluxo,
  type TarefaDoJev,
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

  /**
   * As em cascata acompanham uma REGRA sem IA: não têm ponto (nem cartão de
   * ponto), respondem sim/não e cabem no aceite de cada mensagem. O `decidindo`
   * delas é "Avisar a equipe": o que ele promete, na tela e no diálogo, é um
   * aviso na Central — nunca passar a conversa nem bloquear.
   */
  it("as tarefas em cascata: sem ponto, sim ou não, cada mensagem sozinha, e decidir é só avisar", () => {
    const cascata = TAREFAS_DO_JEV.filter((t) => t.familia === "cascata");
    expect(cascata.map((t) => t.id)).toEqual([TAREFA_DO_PEDIDO_DE_HUMANO.id, TAREFA_DO_PEDIDO_PARA_PARAR.id]);
    for (const t of cascata) {
      expect(t.ponto, t.id).toBeUndefined();
      expect(t.aoDecidirNoPonto, t.id).toBeUndefined();
      expect(t.primitiva, t.id).toBe("noul");
      expect(t.alcance, t.id).toBe("mensagem");
      for (const frase of [t.aoDecidir, t.aoConfirmarDecidir]) {
        expect(frase, t.id).toContain("abre um aviso na Central");
        expect(frase, t.id).toMatch(/nunca (passa a conversa|bloqueia)/);
      }
    }
    // E nascem observando para quem já tem o Jev ligado (R7), com o selo "Nova".
    const ligado = config({ ligado: true, modo: "decide", aceite: ACEITE });
    expect(cascata.map((t) => [estadoEfetivoDaTarefa(ligado, t), tarefaEhNova(ligado, t)])).toEqual([
      ["observando", true],
      ["observando", true],
    ]);
  });

  it("a chamada do Jev tem nome de gente: a do ponto pela tarefa, a dos pedidos pelo nome dela", () => {
    expect(rotuloDaChamadaDoJev("sentiment_classify")).toBe(TAREFA_DO_CLIMA.rotulo);
    expect(rotuloDaChamadaDoJev(PEDIDOS_DO_CLIENTE.purpose)).toBe(PEDIDOS_DO_CLIENTE.rotulo);
    expect(rotuloDaChamadaDoJev("stage_classifier")).toBeNull();
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

/**
 * A resposta ao follow-up (onda 4): mora no ponto `followup_classify`, é uma
 * escolha entre as saídas do passo, e SÓ OBSERVA nesta versão — a saída dela
 * move o cliente no fluxo. Nenhum caminho a põe decidindo: o cartão não
 * oferece o botão, a rota recusa (`route.test.ts`), e um `decidindo` gravado
 * por outra versão vale observando.
 */
describe("a tarefa do follow-up", () => {
  const ligado = (tarefas?: unknown) => config({ ligado: true, aceite: ACEITE, ...(tarefas ? { tarefas } : {}) });

  it("mora no ponto do classificador de sempre, escolhe entre as saídas, cada mensagem sozinha, e só observa", () => {
    expect(TAREFA_DO_FOLLOWUP).toMatchObject({
      id: "followup",
      ponto: "followup_classify",
      primitiva: "choice",
      alcance: "mensagem",
      familia: "substitui",
    });
    const comoTarefa: TarefaDoJev = TAREFA_DO_FOLLOWUP;
    expect(comoTarefa.aoDecidir).toBeUndefined();
    expect(comoTarefa.aoConfirmarDecidir).toBeUndefined();
    expect(comoTarefa.aoDecidirNoPonto).toBeUndefined();
    expect(rotuloDaChamadaDoJev("followup_classify")).toBe(TAREFA_DO_FOLLOWUP.rotulo);
  });

  it("tarefaPodeDecidir: só a do follow-up não pode", () => {
    expect(TAREFAS_DO_JEV.filter((t) => !tarefaPodeDecidir(t)).map((t) => t.id)).toEqual([TAREFA_DO_FOLLOWUP.id]);
  });

  it("nasce observando para quem já tem o Jev ligado (R7), com o selo Nova", () => {
    expect(estadoEfetivoDaTarefa(ligado(), TAREFA_DO_FOLLOWUP)).toBe("observando");
    expect(tarefaEhNova(ligado(), TAREFA_DO_FOLLOWUP)).toBe(true);
  });

  it("um `decidindo` gravado (por uma versão que deixe decidir, revertida) vale observando — e nas outras, decidindo (controle)", () => {
    const c = ligado({ followup: { estado: "decidindo" }, roteador: { estado: "decidindo" } });
    expect(estadoEfetivoDaTarefa(c, TAREFA_DO_FOLLOWUP)).toBe("observando");
    expect(estadoAoLigar({ ...c, ligado: false }, TAREFA_DO_FOLLOWUP)).toBe("observando");
    expect(estadoEfetivoDaTarefa(c, TAREFA_DO_ROTEADOR)).toBe("decidindo");
    // E pausada continua pausada.
    expect(estadoEfetivoDaTarefa(ligado({ followup: { estado: "desligada" } }), TAREFA_DO_FOLLOWUP)).toBe("desligada");
  });

  describe("algumFluxoQueClassifica — um follow-up com o passo 'Classificar (IA)' que o Jev pode ser perguntado", () => {
    const DUAS = ["quer", "não quer"];
    const no = (type: unknown, classes: unknown = DUAS) => (type === "ai_classify" ? { type, config: { classes } } : { type });
    const com = (...tipos: unknown[]) => ({ versao: { graph: { nodes: tipos.map((type) => no(type)) } } });
    it("basta um passo num fluxo", () => {
      expect(algumFluxoQueClassifica([com("trigger", "action"), com("trigger", "ai_classify")])).toBe(true);
    });
    it("um passo com UMA saída só, ou com saídas que a pergunta recusa, não conta: o Jev nunca é perguntado ali", () => {
      const soCom = (classes: unknown) => ({ versao: { graph: { nodes: [no("trigger"), no("ai_classify", classes)] } } });
      expect(algumFluxoQueClassifica([soCom(["respondeu"])])).toBe(false);
      expect(algumFluxoQueClassifica([soCom(["quer", "quer"])])).toBe(false);
      expect(algumFluxoQueClassifica([soCom(["quer", " "])])).toBe(false);
      expect(algumFluxoQueClassifica([soCom("quer,não quer")])).toBe(false);
      expect(algumFluxoQueClassifica([{ versao: { graph: { nodes: [{ type: "ai_classify" }] } } }])).toBe(false);
      // Controle: a mesma regra da pergunta (`perguntaDoFollowup`).
      expect(algumFluxoQueClassifica([soCom(["respondeu"]), soCom(DUAS)])).toBe(true);
    });
    it("sem o passo, sem fluxo, ou com a versão ilegível, é não", () => {
      expect(algumFluxoQueClassifica([])).toBe(false);
      expect(algumFluxoQueClassifica([com("trigger", "match_reply", "end")])).toBe(false);
      expect(
        algumFluxoQueClassifica([{ versao: null }, { versao: { graph: null } }, { versao: { graph: { nodes: "x" } } }, {}]),
      ).toBe(false);
      expect(algumFluxoQueClassifica([com(null, 7)])).toBe(false);
    });
    it("só a tarefa do follow-up depende dele", () => {
      expect(tarefaSemFluxo(TAREFA_DO_FOLLOWUP, false)).toBe(true);
      expect(tarefaSemFluxo(TAREFA_DO_FOLLOWUP, true)).toBe(false);
      expect(TAREFAS_DO_JEV.filter((t) => tarefaSemFluxo(t, false)).map((t) => t.id)).toEqual([TAREFA_DO_FOLLOWUP.id]);
    });
  });
});
