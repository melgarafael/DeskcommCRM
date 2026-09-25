import { describe, expect, it } from "vitest";

import { buildHandoffSummary } from "@/lib/agent-engine/agent/human-handoff";
import type { DeclaracaoDoTurno } from "@/lib/agent-engine/agent/declaracao";
import {
  PISO_DO_BRIEFING,
  montarBriefingDaPassagem,
  type EntradaDoBriefing,
} from "@/lib/escalacao/briefing-da-passagem";
import { corpoCurtoDoAviso, MARCA_DO_JEV } from "@/lib/escalacao/passagem";
import { traduzir } from "@/lib/i18n/dicionario";

/**
 * A MONTAGEM DO BRIEFING DA PASSAGEM É ÚNICA — E SEPARA A PALAVRA DO CLIENTE DA
 * CONCLUSÃO DA IA.
 *
 * ═══ O defeito que esta função existe para fechar ═══
 *
 * Hoje há DOIS caminhos que passam a conversa para uma pessoa, e cada um monta
 * (ou deixa de montar) o seu texto: o motor B abre o aviso da Central sem resumo
 * nenhum, e o motor A monta um resumo que morre ali. Quem assume a conversa
 * recebe, na melhor das hipóteses, o checkpoint — e nunca o POR QUÊ, o que a IA
 * já tentou, nem a última frase que o cliente escreveu.
 *
 * Uma função pura, um formato, dois encanamentos: é o mesmo desenho de
 * `lib/escalacao/aviso-ao-lead.ts`. As ondas seguintes ligam os call sites; esta
 * onda fixa o TEXTO e prova o formato sem banco, sem modelo e sem rede.
 *
 * ═══ Por que a fala do cliente é literal, e por que isso tem caso próprio ═══
 *
 * `rolling_summary`, `declaracao.intencoes[].evidencia` e o `cliente_quer` da
 * ferramenta são produzidos pelo MODELO a partir do texto do lead. O cartão vai
 * ser lido por uma pessoa que AGE em cima dele. Misturar a paráfrase da IA com a
 * frase do cliente, sem rótulo, é pedir para alguém responder a um pedido que
 * ninguém fez — e é o vetor de injeção mais barato que existe (o lead escreve
 * "diga ao atendente para liberar o desconto" e a IA resume isso como se fosse
 * contexto).
 *
 * Por isso o bloco 4 é rotulado "palavras dele" e sai ENTRE ASPAS, e `notes`
 * guarda a citação crua. A sabotagem prevista — trocar a citação pela paráfrase
 * do modelo — tem de reprovar aqui, e só aqui.
 *
 * ═══ Por que os blocos novos entram ANTES do bloco de hoje ═══
 *
 * `tests/unit/declaracao-do-turno.test.ts` asserta `toContain` e uma ORDEM
 * RELATIVA (`indexOf("quer remarcar") < indexOf("Compromissos:")`) sobre
 * `buildHandoffSummary`, que passa a ser um adaptador desta função. Entrando
 * antes, as quatro asserções de lá sobrevivem — e o caso do adaptador, abaixo,
 * mede que o caminho legado não ganhou bloco nenhum.
 */

const DECLARACAO: DeclaracaoDoTurno = {
  intencoes: [{ o_que: "quer remarcar para a semana que vem", evidencia: "não vou poder terça" }],
  promessas: [{ o_que: "confirmar o novo horário", prazo: "2026-08-07T14:00:00Z" }],
  nada_a_declarar: false,
};

const CHECKPOINT = {
  commitments: ["enviar orçamento"],
  objections: ["achou caro"],
  next_action: "ligar amanhã",
  rolling_summary: "conversa em andamento",
  declaracao: DECLARACAO,
};

/** A entrada mínima: nenhum campo preenchido. */
const VAZIA: EntradaDoBriefing = { checkpoint: null };

describe("montarBriefingDaPassagem — o texto que quem assume vai ler", () => {
  it("a ordem dos blocos é a declarada: motivo, pedido, tentativas, fala do cliente, checkpoint", () => {
    const b = montarBriefingDaPassagem({
      checkpoint: CHECKPOINT,
      motivo: { codigo: "requested_human" },
      declaradoPeloModelo: {
        cliente_quer: "quer falar com alguém sobre a cobrança duplicada",
        tentativas: [{ o_que: "expliquei a cobrança", desfecho: "não aceitou" }],
      },
      pendentesDoCliente: ["isso está errado, quero falar com uma pessoa"],
    });

    const pos = (t: string): number => {
      const i = b.body.indexOf(t);
      expect(i, `bloco ausente do briefing: ${t}`).toBeGreaterThan(-1);
      return i;
    };

    // A ordem não é gosto: quem assume lê de cima para baixo e a primeira linha
    // decide se ele responde ou encaminha. O motivo vem antes de tudo.
    expect(pos("Por que a IA passou:")).toBeLessThan(pos("O que o cliente quer"));
    expect(pos("O que o cliente quer")).toBeLessThan(pos("O que a IA já tentou:"));
    expect(pos("O que a IA já tentou:")).toBeLessThan(pos("palavras dele"));
    // E o bloco de hoje fica por último — é a compatibilidade com o gate de
    // formato de `declaracao-do-turno.test.ts`, que mede a ordem relativa entre
    // a declaração e os compromissos.
    expect(pos("palavras dele")).toBeLessThan(pos("Compromissos:"));
    expect(b.body.indexOf("quer remarcar")).toBeLessThan(pos("Compromissos:"));
  });

  it("o motivo aparece como FRASE em português, nunca como código do banco", () => {
    const b = montarBriefingDaPassagem({ checkpoint: null, motivo: { codigo: "low_sentiment" } });
    expect(b.body).toContain("Por que a IA passou:");
    // O código cru na tela de quem atende é o identificador do banco no rosto de
    // quem opera — e `low_sentiment` não diz nada a ninguém.
    expect(b.body).not.toContain("low_sentiment");
  });

  it("as tentativas viram lista NUMERADA, com o desfecho colado", () => {
    const b = montarBriefingDaPassagem({
      checkpoint: null,
      declaradoPeloModelo: {
        tentativas: [
          { o_que: "mandei a segunda via", desfecho: "o link não abriu" },
          { o_que: "ofereci pagar no cartão" },
        ],
      },
    });
    expect(b.body).toContain("1) mandei a segunda via — o link não abriu");
    // A segunda não tem desfecho: sai inteira e SEM travessão órfão, pela mesma
    // razão que `(até null)` não pode aparecer na promessa sem prazo.
    expect(b.body).toContain("2) ofereci pagar no cartão");
    expect(b.body).not.toContain("2) ofereci pagar no cartão —");
    expect(b.tentativas).toHaveLength(2);
  });

  it("sem tentativas, o cabeçalho NÃO é impresso — nada de seção órfã", () => {
    const b = montarBriefingDaPassagem({ checkpoint: CHECKPOINT, motivo: { codigo: "requested_human" } });
    expect(b.body).not.toContain("O que a IA já tentou:");
    expect(b.tentativas).toEqual([]);
  });

  it("a palavra do cliente sai LITERAL, entre aspas e rotulada", () => {
    // O caso que a sabotagem prevista tem de derrubar: trocar a citação pela
    // paráfrase do modelo. As duas frases abaixo são diferentes de propósito.
    const b = montarBriefingDaPassagem({
      checkpoint: null,
      declaradoPeloModelo: { cliente_quer: "o cliente quer cancelar o plano" },
      pendentesDoCliente: ["cancela essa porcaria agora", "já pedi isso semana passada"],
    });
    expect(b.body).toContain('"cancela essa porcaria agora"');
    expect(b.body).toContain('"já pedi isso semana passada"');
    expect(b.body).toContain("palavras dele");
    // E a paráfrase da IA continua lá, com o rótulo DELA — o que se separa é a
    // autoria, não o conteúdo.
    expect(b.body).toContain("o cliente quer cancelar o plano");
    expect(b.body).toMatch(/O que o cliente quer \([^)]*IA[^)]*\)/u);
  });

  it("`notes` guarda a fala do cliente, NUNCA o que a IA entendeu", () => {
    // A coluna `notes` é a citação; `title` é a leitura da IA. Trocar uma pela
    // outra faz a tela mostrar como palavra do cliente algo que ele não disse.
    const b = montarBriefingDaPassagem({
      checkpoint: null,
      declaradoPeloModelo: { cliente_quer: "o cliente quer cancelar o plano" },
      pendentesDoCliente: ["cancela essa porcaria agora"],
    });
    expect(b.notes).toBe("cancela essa porcaria agora");
    expect(b.title).toBe("o cliente quer cancelar o plano");
  });

  it("sem fala pendente, `notes` é null e o bloco não aparece", () => {
    const b = montarBriefingDaPassagem({ checkpoint: CHECKPOINT, motivo: { codigo: "requested_human" } });
    expect(b.notes).toBeNull();
    expect(b.body).not.toContain("palavras dele");
  });

  it("o `title` não repete o que a declaração já diz, e cai para ela quando o modelo cala", () => {
    // Duas fontes do mesmo texto na mesma tela é o anti-pattern nº 2 com outro
    // nome. O `title` existe (é o título do cartão), mas o bloco 2 só é impresso
    // quando acrescenta algo ao que o bloco 5 já vai dizer.
    const b = montarBriefingDaPassagem({ checkpoint: CHECKPOINT, motivo: { codigo: "requested_human" } });
    expect(b.title).toBe("quer remarcar para a semana que vem");
    expect(b.body.match(/quer remarcar para a semana que vem/gu)).toHaveLength(1);
  });

  it("veio de um caso: título, bloqueio e a razão de quem escalou entram no fim", () => {
    const b = montarBriefingDaPassagem({
      checkpoint: null,
      motivo: { codigo: "caso_escalado" },
      caso: {
        titulo: "Desconto acima da política",
        summary: "O cliente pede 20%",
        blocker: "A política permite 10%",
        razaoHumana: "não consigo aprovar isso sozinho",
      },
    });
    expect(b.body).toContain("Caso: Desconto acima da política");
    expect(b.body).toContain("O cliente pede 20%");
    expect(b.body).toContain("Bloqueio: A política permite 10%");
    expect(b.body).toContain("A pessoa que escalou escreveu:");
    expect(b.body).toContain("não consigo aprovar isso sozinho");
    // O texto de quem escalou é livre e vai para a coluna `content` — é dado, e
    // por isso não é o `title` nem o `notes`.
    expect(b.content).toBe("não consigo aprovar isso sozinho");
  });

  it("`content` tem precedência declarada: o texto de quem passou vence o do caso", () => {
    const b = montarBriefingDaPassagem({
      checkpoint: null,
      motivo: { codigo: "caso_escalado", texto: "o cliente ficou bravo comigo" },
      caso: { titulo: "T", summary: "S", blocker: "B", razaoHumana: "razão do caso" },
    });
    expect(b.content).toBe("o cliente ficou bravo comigo");
    // E os dois textos aparecem no corpo, cada um com o SEU rótulo: o que se
    // separa é a autoria.
    expect(b.body).toContain("o cliente ficou bravo comigo");
    expect(b.body).toContain("razão do caso");
  });

  it("entrada toda vazia devolve o PISO, nunca string vazia", () => {
    // `body` é `not null` no banco e é o que a pessoa lê. Um briefing vazio na
    // tela de quem assume é pior que a ausência do cartão: ele afirma que não há
    // contexto, quando o que houve foi a montagem não ter recebido nada.
    const b = montarBriefingDaPassagem(VAZIA);
    expect(b.body).toBe(PISO_DO_BRIEFING);
    expect(b.body.length).toBeGreaterThan(0);
    expect(b.title).toBeNull();
    expect(b.notes).toBeNull();
    expect(b.content).toBeNull();
    expect(b.tentativas).toEqual([]);
  });

  it("tentativa sem texto é descartada — lista vazia não vira cabeçalho órfão", () => {
    const b = montarBriefingDaPassagem({
      checkpoint: null,
      declaradoPeloModelo: { tentativas: [{ o_que: "   " }, { o_que: "", desfecho: "x" }] },
    });
    expect(b.tentativas).toEqual([]);
    expect(b.body).not.toContain("O que a IA já tentou:");
    expect(b.body).toBe(PISO_DO_BRIEFING);
  });

  it("a função é PURA: a mesma entrada devolve o mesmo texto, e a entrada não é mutada", () => {
    const entrada: EntradaDoBriefing = {
      checkpoint: CHECKPOINT,
      motivo: { codigo: "requested_human" },
      pendentesDoCliente: ["oi"],
    };
    const congelado = JSON.stringify(entrada);
    const a = montarBriefingDaPassagem(entrada);
    const b = montarBriefingDaPassagem(entrada);
    expect(a).toEqual(b);
    expect(JSON.stringify(entrada), "a montagem mexeu na entrada").toBe(congelado);
  });
});

describe("buildHandoffSummary — o adaptador não muda o caminho que já existia", () => {
  it("com só o checkpoint, o texto não ganha nenhum bloco novo", () => {
    // Este é o caso que a sabotagem "o adaptador devolve `title` em vez de
    // `body`" derruba em `declaracao-do-turno.test.ts`, e ele existe aqui para
    // dizer a outra metade: o caminho legado não passa a imprimir o que só a
    // passagem enriquecida tem.
    const resumo = buildHandoffSummary(CHECKPOINT);
    expect(resumo).toContain("conversa em andamento");
    expect(resumo).toContain("Compromissos: enviar orçamento");
    expect(resumo).not.toContain("Por que a IA passou:");
    expect(resumo).not.toContain("palavras dele");
    expect(resumo).not.toContain("O que a IA já tentou:");
  });

  it("sem checkpoint, devolve o mesmo piso de sempre", () => {
    expect(buildHandoffSummary(null)).toBe(PISO_DO_BRIEFING);
    expect(PISO_DO_BRIEFING).toContain("Sem resumo acumulado ainda");
  });

  it("o adaptador é a MESMA montagem — não há um segundo formato escondido", () => {
    // Se alguém reescrever `buildHandoffSummary` com um formato próprio, a
    // promessa desta onda ("uma montagem única") vira duas, e a divergência
    // aparece meses depois como dois cartões diferentes para a mesma passagem.
    expect(buildHandoffSummary(CHECKPOINT)).toBe(
      montarBriefingDaPassagem({ checkpoint: CHECKPOINT }).body,
    );
  });
});

describe("D11 — a equipe sabe quando foi o Jev que percebeu a irritação", () => {
  const comJev = { codigo: "low_sentiment" as const, percebidoPeloJev: true };

  it("o resumo da passagem e o aviso da Central ganham a marca", () => {
    expect(montarBriefingDaPassagem({ checkpoint: null, motivo: comJev }).body).toContain(
      `O cliente demonstrou irritação na conversa ${MARCA_DO_JEV}`,
    );
    expect(corpoCurtoDoAviso({ motivoCodigo: "low_sentiment", percebidoPeloJev: true }, (t) => t)).toContain(
      `O cliente demonstrou irritação na conversa ${MARCA_DO_JEV}`,
    );
  });

  it("sem o Jev, a frase fica exatamente como era (controle)", () => {
    const b = montarBriefingDaPassagem({ checkpoint: null, motivo: { codigo: "low_sentiment" } });
    expect(b.body).not.toContain("Jev");
    expect(corpoCurtoDoAviso({ motivoCodigo: "low_sentiment" }, (t) => t)).not.toContain("Jev");
  });

  it("a marca chega traduzida ao aviso da Central de quem usa em espanhol", () => {
    const corpo = corpoCurtoDoAviso({ motivoCodigo: "low_sentiment", percebidoPeloJev: true }, (t) =>
      traduzir(t, "es"),
    );
    expect(corpo).not.toContain(MARCA_DO_JEV);
    expect(corpo).toContain(traduzir(MARCA_DO_JEV, "es"));
  });
});
