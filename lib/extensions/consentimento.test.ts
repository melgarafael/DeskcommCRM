import { describe, expect, it } from "vitest";

import {
  CAPACIDADES_DE_EFEITO,
  CAPACIDADES_DE_PORTA,
  EFEITO_DA_CAPACIDADE,
  EXTENSION_PERMISSIONS,
  destinoDaCapacidade,
  permissaoDaCapacidade,
} from "./capacidades";
import {
  PERMISSOES_DE_TURNO,
  PERMISSOES_QUE_EXIGEM_ACEITE,
  aceiteCobre,
  aceitePendente,
  capacidadesDoFluxo,
  ehPermissaoDeTurno,
  exigeAceite,
  motivoDeRecusaDoTurno,
  permissoesAceitaveis,
  permissoesDoFluxo,
} from "./consentimento";
import type { FluxoDoTurno } from "./fluxo-do-turno";
import { nomeDaPorta, portasLegiveis } from "./portas-legiveis";

/**
 * A CONCESSÃO NOMEADA — o que o mantenedor fechou o #3456 por faltar.
 *
 * A frase dele: "a ativação genérica não substitui uma concessão explícita de envio e handoff nem
 * a verificação dessa mudança nas atualizações". Este arquivo mede as três coisas:
 *
 *   1. envio e handoff são CAPACIDADES NOMEADAS com PERMISSÕES NOMEADAS no vocabulário fechado;
 *   2. sem aceite a extensão não age — e o motivo diz qual dos dois elos faltou;
 *   3. permissão nova invalida o aceite antigo; permissão REMOVIDA não invalida nada.
 */
const fluxoComEncerramento: Pick<FluxoDoTurno, "desfecho"> = {
  desfecho: {
    tipo: "assumir",
    texto: { "pt-BR": "Anotei, obrigado!", en: "Noted, thank you!" },
  },
};

const fluxoComPassagem: Pick<FluxoDoTurno, "desfecho"> = {
  desfecho: {
    tipo: "passar_para_humano",
    aviso: { "pt-BR": "Vou passar para a equipe.", en: "I will pass this to the team." },
  },
};

const TODAS = [...PERMISSOES_DE_TURNO];

describe("capacidades nomeadas do turno", () => {
  it("envio e handoff existem como capacidade E como permissão — as duas nomeadas", () => {
    expect(CAPACIDADES_DE_EFEITO).toEqual(["turn.respond", "turn.handoff"]);
    // A capacidade não é o nome da permissão: o mapa é a única tradução, como em `tasks.open`.
    expect(EFEITO_DA_CAPACIDADE["turn.respond"]).toEqual({
      efeito: "envio",
      permissao: "turn.send",
    });
    expect(EFEITO_DA_CAPACIDADE["turn.handoff"]).toEqual({
      efeito: "passagem",
      permissao: "turn.handoff",
    });
    // E a permissão está no vocabulário FECHADO — o que a tela mostra e o banco valida.
    for (const efeito of CAPACIDADES_DE_EFEITO) {
      expect(EXTENSION_PERMISSIONS).toContain(permissaoDaCapacidade(efeito));
    }
  });

  it("capacidade de efeito NÃO devolve destino — ela não navega", () => {
    for (const capacidade of CAPACIDADES_DE_EFEITO) {
      expect(destinoDaCapacidade(capacidade), `${capacidade} virou link`).toBeNull();
    }
    // E as portas continuam devolvendo destino, para a prova de que não esvaziei o mapa.
    for (const capacidade of CAPACIDADES_DE_PORTA) {
      expect(destinoDaCapacidade(capacidade)).toMatch(/^\/app\//);
    }
  });

  it("toda permissão que exige aceite está no vocabulário e tem nome de tela", () => {
    for (const permissao of PERMISSOES_QUE_EXIGEM_ACEITE) {
      expect(EXTENSION_PERMISSIONS).toContain(permissao);
      expect(ehPermissaoDeTurno(permissao)).toBe(true);
      expect(exigeAceite(permissao)).toBe(true);
      expect(nomeDaPorta(permissao).length).toBeGreaterThan(0);
    }
    // Navegação, tema e dados NÃO pedem aceite próprio: a ativação (admin, tela de
    // permissões) continua sendo o consentimento delas. Se alguém acrescentar uma
    // permissão de efeito nova sem entrar na lista, este teste cai.
    expect(exigeAceite("navigation.tasks")).toBe(false);
    expect(exigeAceite("theme.apply")).toBe(false);
    expect(exigeAceite("dados.proprios")).toBe(false);
  });

  it("a frase da tela não diz 'Abre' para quem responde ao cliente", () => {
    const frase = portasLegiveis(["turn.send", "turn.handoff"]);
    expect(frase).not.toContain("Abre");
    expect(frase).toContain("Responde ao cliente no seu lugar");
    expect(frase).toContain("passa a conversa para uma pessoa");
    // Misturado com porta: as duas orações aparecem.
    const misto = portasLegiveis(["navigation.tasks", "turn.send"]);
    expect(misto).toContain("Tarefas");
    expect(misto).toContain("Responde ao cliente no seu lugar");
  });
});

describe("o que o fluxo exige é DERIVADO do desfecho", () => {
  it("encerrar a coleta pede só o envio; passar para humano pede envio e handoff", () => {
    expect(capacidadesDoFluxo(fluxoComEncerramento)).toEqual(["turn.respond"]);
    expect(permissoesDoFluxo(fluxoComEncerramento)).toEqual(["turn.send"]);
    expect(capacidadesDoFluxo(fluxoComPassagem)).toEqual(["turn.respond", "turn.handoff"]);
    expect(permissoesDoFluxo(fluxoComPassagem)).toEqual(["turn.send", "turn.handoff"]);
  });
});

describe("sem aceite, a extensão não age (exigência 2)", () => {
  it("manifesto completo e NENHUM aceite ⇒ sem_aceite", () => {
    expect(
      motivoDeRecusaDoTurno({ declaradas: TODAS, aceitas: [], fluxo: fluxoComPassagem }),
    ).toBe("sem_aceite");
  });

  it("fluxo de passagem com só `turn.send` declarado ⇒ sem_permissao_declarada", () => {
    expect(
      motivoDeRecusaDoTurno({
        declaradas: ["turn.send"],
        aceitas: TODAS,
        fluxo: fluxoComPassagem,
      }),
    ).toBe("sem_permissao_declarada");
  });

  it("manifesto sem permissão de turno nenhuma ⇒ sem_permissao_declarada, não sem_aceite", () => {
    // A ordem dos motivos importa para quem depura: primeiro o contrato, depois a concessão.
    expect(
      motivoDeRecusaDoTurno({
        declaradas: ["navigation.tasks"],
        aceitas: [],
        fluxo: fluxoComPassagem,
      }),
    ).toBe("sem_permissao_declarada");
  });

  it("aceite dos dois e manifesto dos dois ⇒ age", () => {
    expect(motivoDeRecusaDoTurno({ declaradas: TODAS, aceitas: TODAS, fluxo: fluxoComPassagem })).toBeNull();
  });
});

describe("atualização: permissão nova exige aceite novo (exigência 3)", () => {
  it("versão que passa a pedir `turn.handoff` NÃO herda o aceite de `turn.send`", () => {
    // v1: só encerrava a coleta. A organização aceitou `turn.send`.
    const v1 = motivoDeRecusaDoTurno({
      declaradas: ["turn.send"],
      aceitas: ["turn.send"],
      fluxo: fluxoComEncerramento,
    });
    expect(v1).toBeNull();
    // v2: passou a entregar a conversa a uma pessoa.
    const v2 = motivoDeRecusaDoTurno({
      declaradas: TODAS,
      aceitas: ["turn.send"],
      fluxo: fluxoComPassagem,
    });
    expect(v2).toBe("aceite_desatualizado");
    // E o que a tela pede é exatamente a permissão que falta — nem uma a mais.
    expect(aceitePendente({ declaradas: TODAS, aceitas: ["turn.send"], fluxo: fluxoComPassagem })).toEqual([
      "turn.handoff",
    ]);
    // Com o aceite novo, age.
    expect(motivoDeRecusaDoTurno({ declaradas: TODAS, aceitas: TODAS, fluxo: fluxoComPassagem })).toBeNull();
  });

  it("permissão REMOVIDA não quebra nada: a cobertura é de subconjunto", () => {
    // A organização aceitou um conjunto maior do que a versão vigente usa. Isso é o
    // resultado esperado de uma versão mais modesta — e não pode parar a conversa.
    const recusa = motivoDeRecusaDoTurno({
      declaradas: ["turn.send"],
      aceitas: ["turn.send", "turn.handoff", "navigation.tasks"],
      fluxo: fluxoComEncerramento,
    });
    expect(recusa).toBeNull();
    expect(aceiteCobre(["turn.send"], ["turn.send", "turn.handoff"])).toBe(true);
    expect(aceiteCobre(["turn.send", "turn.handoff"], ["turn.send"])).toBe(false);
  });

  it("aceite vazio não é 'desatualizado' — é 'sem_aceite' (primeiro aceite, não revisão)", () => {
    expect(aceitePendente({ declaradas: TODAS, aceitas: [], fluxo: fluxoComPassagem })).toEqual([
      "turn.send",
      "turn.handoff",
    ]);
  });
});

describe("o que a organização PODE aceitar", () => {
  it("só as permissões de turno que o manifesto declara", () => {
    expect(permissoesAceitaveis(["turn.send", "navigation.tasks"])).toEqual(["turn.send"]);
    expect(permissoesAceitaveis(TODAS)).toEqual(TODAS);
    // Nada declarado ⇒ nada a aceitar: aceitar o que o pacote não pede seria conceder
    // autoridade para um efeito que ele não tem.
    expect(permissoesAceitaveis(["navigation.tasks"])).toEqual([]);
  });
});
