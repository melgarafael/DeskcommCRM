/**
 * O MENU DO ROBÔ DO OUTRO LADO NÃO PASSA A CONVERSA PARA UM HUMANO (issue 3106).
 *
 * ## O defeito medido (1.86.0, duas vezes na mesma semana)
 *
 * A Prospecção abre a conversa. Segundos depois a empresa abordada responde com o
 * menu automático dela — "1 - Agendar consulta · … · 4 - Falar com um atendente".
 * O padrão determinístico de `human-handoff.ts` casa o rótulo da QUARTA OPÇÃO, o
 * turno manda ao robô "Claro! Já estou chamando alguém da equipe…", marca
 * `force_human`, joga a conversa na Fila e abre demanda. O modelo nunca vê a
 * mensagem, e cada caso vira trabalho manual de alguém.
 *
 * ## O que este arquivo prova, pela FUNÇÃO (não pelo DOM)
 *
 * A frase continua casando — `HUMAN_HANDOFF_PATTERNS` não muda, porque um pedido
 * de verdade tem de ser reconhecido sempre. O que passa a decidir a passagem é a
 * leitura do casamento: `ehRespostaDeRobo` responde se o que casou é fala de
 * automação (menu numerado, mensagem que se declara robô, ou saudação que chega
 * na janela da nossa abertura). O turno usa exatamente a expressão
 * `detectHumanHandoffRequest(texto) && !ehRespostaDeRobo(texto, historico)`, e é
 * ela que os casos abaixo exercitam — a MESMA linha que roda no turno.
 *
 * As cinco condições do desenho do autor da issue:
 *
 *   1. menu numerado do robô NÃO dispara (é o defeito);
 *   2. pedido humano de gente de verdade continua disparando;
 *   3. mensagem do robô segundos depois da nossa abertura NÃO dispara;
 *   4. conversa de Prospecção sem nenhuma fala humana NÃO dispara;
 *   5. CONTROLE — fora dessas condições a detecção determinística segue valendo.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  chegouNaJanelaDaSaudacaoAutomatica,
  detectHumanHandoffRequest,
  ehMensagemDeRobo,
  ehMenuDeOpcoesNumeradas,
  ehRespostaDeRobo,
  type MensagemDoHistorico,
} from "@/lib/agent-engine/agent/human-handoff";

/**
 * A EXPRESSÃO DO TURNO, num lugar só. Se o turno deixar de usar a guarda, este
 * arquivo fica verde à toa — por isso `fiacao` (no fim) vigia a ligação no fonte.
 */
function pedidoDeGente(texto: string, historico: readonly MensagemDoHistorico[]): boolean {
  return detectHumanHandoffRequest(texto) && !ehRespostaDeRobo(texto, historico);
}

/** O menu que a empresa abordada manda segundos depois da nossa primeira mensagem. */
const MENU_DO_ROBO = [
  "Olá! Sou o assistente virtual da Clínica Vida 😊",
  "Para agilizar o seu atendimento, escolha uma opção:",
  "1 - Agendar consulta",
  "2 - Valores e convênios",
  "3 - Endereço e horários",
  "4 - Falar com um atendente",
  "Digite o número da opção desejada.",
].join("\n");

/** A saudação automática SEM numeração — a que só a janela da abertura denuncia. */
const SAUDACAO_DO_ROBO =
  "Olá! Recebemos a sua mensagem. Para falar com um atendente é só responder por aqui.";

/** A nossa abertura de Prospecção: a conversa NASCEU daqui (é o disparo). */
const NOSSA_ABERTURA =
  "Boa tarde! Falo do time da Webtecnica. Vi que o site de vocês estava fora do ar ontem — posso te mostrar o que medimos?";

/** Histórico de conversa ESTABELECIDA: o cliente abriu, já houve idas e vindas. */
function historicoEstabelecido(): MensagemDoHistorico[] {
  return [
    { direction: "inbound", body: "boa tarde, tudo bem?", sent_at: "2026-10-19T09:00:00-03:00" },
    { direction: "outbound", body: "Tudo ótimo! Como posso ajudar?", sent_at: "2026-10-19T09:02:00-03:00" },
    { direction: "inbound", body: "queria saber o preço do C180", sent_at: "2026-10-19T09:20:00-03:00" },
    { direction: "outbound", body: "O C180 sai por R$ 189 mil.", sent_at: "2026-10-19T09:21:00-03:00" },
  ];
}

/** Histórico de Prospecção: a primeira mensagem é NOSSA e o outro lado só mandou o menu. */
function historicoDeProspeccao(textoDoRobo: string, segundosDepois: number): MensagemDoHistorico[] {
  const abertura = Date.parse("2026-10-19T14:00:00-03:00");
  return [
    { direction: "outbound", body: NOSSA_ABERTURA, sent_at: new Date(abertura).toISOString() },
    {
      direction: "inbound",
      body: textoDoRobo,
      sent_at: new Date(abertura + segundosDepois * 1000).toISOString(),
    },
  ];
}

describe("1 — menu numerado do robô: NÃO dispara handoff (o defeito da issue)", () => {
  it("o rótulo '4 - Falar com um atendente' casa o padrão — e é isso que passava a conversa", () => {
    // Controle do defeito: o detector determinístico VÊ o pedido no menu. Sem
    // esta asserção, um verde aqui não provaria nada (poderia ser o padrão que
    // deixou de casar, e não a guarda que passou a descontar o menu).
    expect(detectHumanHandoffRequest(MENU_DO_ROBO)).toBe(true);
    expect(ehMenuDeOpcoesNumeradas(MENU_DO_ROBO)).toBe(true);
  });

  it("em conversa comum, o menu não vira passagem para humano", () => {
    expect(ehRespostaDeRobo(MENU_DO_ROBO, historicoEstabelecido())).toBe(true);
    expect(pedidoDeGente(MENU_DO_ROBO, historicoEstabelecido())).toBe(false);
  });
});

describe("2 — pedido humano de gente de verdade continua disparando", () => {
  it("a pergunta real do cliente com o pedido colado nela passa a conversa", () => {
    const pedido = "Boa tarde, o preço do C180 é esse mesmo? Quero falar com um atendente para fechar.";
    expect(ehRespostaDeRobo(pedido, historicoEstabelecido())).toBe(false);
    expect(pedidoDeGente(pedido, historicoEstabelecido())).toBe(true);
  });

  it("as frases clássicas seguem casando, também sem histórico nenhum", () => {
    for (const frase of [
      "quero falar com uma pessoa",
      "me passa para um atendente, por favor",
      "preciso de atendimento humano",
    ]) {
      expect(pedidoDeGente(frase, []), frase).toBe(true);
    }
  });
});

describe("3 — fala do robô segundos depois da NOSSA abertura: NÃO dispara", () => {
  it("a saudação automática sem numeração é reconhecida pela janela da abertura", () => {
    const historico = historicoDeProspeccao(SAUDACAO_DO_ROBO, 4);
    // A marca da janela e a guarda inteira — as duas, porque a segunda é a que o turno usa.
    expect(chegouNaJanelaDaSaudacaoAutomatica(SAUDACAO_DO_ROBO, historico)).toBe(true);
    expect(ehRespostaDeRobo(SAUDACAO_DO_ROBO, historico)).toBe(true);
    expect(pedidoDeGente(SAUDACAO_DO_ROBO, historico)).toBe(false);
  });

  it("a MESMA frase, quando a conversa é antiga, volta a valer (a janela é curta de propósito)", () => {
    // Sem esta metade, a janela viraria um silêncio permanente sobre uma frase.
    const historico = historicoDeProspeccao(SAUDACAO_DO_ROBO, 15 * 60);
    expect(chegouNaJanelaDaSaudacaoAutomatica(SAUDACAO_DO_ROBO, historico)).toBe(false);
    expect(pedidoDeGente(SAUDACAO_DO_ROBO, historico)).toBe(true);
  });
});

describe("4 — conversa de Prospecção sem nenhuma fala humana: NÃO dispara", () => {
  it("o menu do robô na resposta ao nosso disparo não abre Fila nem demanda", () => {
    const historico = historicoDeProspeccao(MENU_DO_ROBO, 6);
    expect(ehMensagemDeRobo(MENU_DO_ROBO)).toBe(true);
    expect(ehRespostaDeRobo(MENU_DO_ROBO, historico)).toBe(true);
    expect(pedidoDeGente(MENU_DO_ROBO, historico)).toBe(false);
  });

  it("mas o pedido de uma PESSOA na mesma conversa de Prospecção continua passando", () => {
    // O que veio do disparo não é um "silêncio de prospecção": quem responde por
    // si pedindo uma pessoa é atendido como sempre.
    const pedido = "vi seu contato aqui, quero falar com um atendente sobre o site de vocês";
    const historico = historicoDeProspeccao(pedido, 15 * 60);
    expect(ehRespostaDeRobo(pedido, historico)).toBe(false);
    expect(pedidoDeGente(pedido, historico)).toBe(true);
  });
});

describe("5 — CONTROLE: fora dessas condições a detecção determinística segue valendo", () => {
  it("sem histórico, a guarda não tem o que descontar e a passagem acontece", () => {
    expect(pedidoDeGente("quero falar com um atendente", [])).toBe(true);
  });

  it("o histórico que não traz data não desliga a passagem (falha aberta)", () => {
    const semData: MensagemDoHistorico[] = [
      { direction: "outbound", body: NOSSA_ABERTURA },
      { direction: "inbound", body: SAUDACAO_DO_ROBO },
    ];
    expect(chegouNaJanelaDaSaudacaoAutomatica(SAUDACAO_DO_ROBO, semData)).toBe(false);
    expect(pedidoDeGente(SAUDACAO_DO_ROBO, semData)).toBe(true);
  });

  it("mensagem vazia nunca é pedido — nem de gente, nem de robô", () => {
    expect(ehRespostaDeRobo("   ", historicoEstabelecido())).toBe(false);
    expect(pedidoDeGente("   ", historicoEstabelecido())).toBe(false);
  });
});

describe("as três marcas, uma por uma", () => {
  it("menu: duas opções numeradas bastam; uma citação solta não é menu", () => {
    expect(ehMenuDeOpcoesNumeradas("1 - Agendar\n2 - Falar com um atendente")).toBe(true);
    expect(ehMenuDeOpcoesNumeradas("1️⃣ Agendar\n2️⃣ Falar com um atendente")).toBe(true);
    expect(ehMenuDeOpcoesNumeradas("Olá! Digite o número da opção desejada")).toBe(true);
    // Uma pessoa que cita a opção do menu para se explicar continua sendo uma pessoa.
    expect(ehMenuDeOpcoesNumeradas("quero a opção 4, falar com um atendente")).toBe(false);
    expect(ehMenuDeOpcoesNumeradas("chegou em 2 minutos, quero falar com um atendente")).toBe(false);
  });

  it("marca de robô: quem se declara automação não é quem pede uma pessoa", () => {
    expect(ehMensagemDeRobo("Sou o assistente virtual da loja, fale com um atendente")).toBe(true);
    expect(ehMensagemDeRobo("Esta é uma mensagem automática de retorno")).toBe(true);
    expect(ehMensagemDeRobo("quero falar com um atendente, por favor")).toBe(false);
  });

  it("janela da abertura: só quando a conversa NASCEU de nós", () => {
    // A conversa do cliente: a primeira mensagem é dele, e a janela não existe.
    expect(chegouNaJanelaDaSaudacaoAutomatica("qualquer texto", historicoEstabelecido())).toBe(false);
    // A mensagem avaliada precisa estar no histórico — sem ocorrência, nada a medir.
    expect(
      chegouNaJanelaDaSaudacaoAutomatica("texto que não está lá", historicoDeProspeccao(MENU_DO_ROBO, 6)),
    ).toBe(false);
    expect(chegouNaJanelaDaSaudacaoAutomatica(MENU_DO_ROBO, historicoDeProspeccao(MENU_DO_ROBO, 6))).toBe(
      true,
    );
    // Data no futuro do relógio (ou fora da janela) não marca nada.
    expect(chegouNaJanelaDaSaudacaoAutomatica(MENU_DO_ROBO, historicoDeProspeccao(MENU_DO_ROBO, 61))).toBe(
      false,
    );
  });
});

/** O menu da issue 3106, LITERAL: uma linha só, itens separados por " / ". */
const MENU_DA_ISSUE =
  "Digite o número de acordo a opção desejada: 1-Médicos / 2-Terapias / 3-Exames / 4-Falar com um atendente";

describe("CONTROLE — gente reclamando do NOSSO robô continua sendo gente", () => {
  // As marcas olham a FORMA da mensagem; quem reclama do bot cita o bot, cita a
  // instrução do menu e às vezes numera as próprias dúvidas. Nenhuma dessas
  // falas se declara automação nem faz do pedido uma opção de menu.
  it.each([
    "esse assistente virtual não resolve nada, quero falar com um atendente",
    "cansei desse atendimento automático, quero falar com uma pessoa",
    "cansei de mensagem automática de vocês, quero falar com um atendente",
    "esta mensagem automática não responde nada, quero falar com um atendente",
    "eu não sou um robô, quero falar com uma pessoa",
    "não sei qual a opção desejada, quero falar com um atendente",
    "Tenho 2 dúvidas:\n1. o preço\n2. o prazo\nquero falar com um atendente",
  ])("%s", (frase) => {
    expect(pedidoDeGente(frase, historicoEstabelecido())).toBe(true);
  });
});

describe("o menu LITERAL da issue continua barrado", () => {
  it("o item '4-Falar com um atendente' de um menu de uma linha só não passa a conversa", () => {
    expect(detectHumanHandoffRequest(MENU_DA_ISSUE)).toBe(true);
    expect(pedidoDeGente(MENU_DA_ISSUE, historicoEstabelecido())).toBe(false);
  });

  it("datas como '12/10' não viram itens de menu", () => {
    const frase = "Pedi para 12/10. Remarcaram para 20/11. Quero falar com um atendente";
    expect(pedidoDeGente(frase, historicoEstabelecido())).toBe(true);
  });
});

/**
 * FIAÇÃO — presença antes de comportamento. Uma guarda que existe e ninguém
 * chama é o mesmo defeito de antes com mais linhas; e a prova de que ela decide
 * (e não apenas existe) são os casos acima, que usam a MESMA expressão do turno.
 */
describe("fiação — o turno USA a guarda nos DOIS pontos de decisão", () => {
  const FONTE = readFileSync(join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts"), "utf8");

  it("o pedido explícito só passa acompanhado de `!ehRespostaDeRobo` (caminho automático e assistido)", () => {
    expect((FONTE.match(/detectHumanHandoffRequest\(texto\)/gu) ?? []).length).toBe(2);
    expect((FONTE.match(/!ehRespostaDeRobo\(texto, /gu) ?? []).length).toBe(2);
  });
});
