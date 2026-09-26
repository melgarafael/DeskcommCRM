/**
 * O QUE O JEV DIZ A QUEM OPERA — IA › Execuções e a Central de avisos.
 *
 * Quem lê é o dono do negócio. Cada frase diz o que aconteceu e o que dá para
 * fazer, sem código de status nem nome de campo. As frases chegam à tela por
 * `t(variável)`, então o espanhol é cobrado por `./textos.test.ts`.
 *
 * Os códigos têm prefixo `jev_` porque moram na MESMA coluna
 * (`llm_calls.error_code`) que os da IA de sempre, e `provedor_indisponivel` já
 * existe lá com outra frase ("troque de provedor nesse ponto") — conselho que
 * não serve ao Jev, que não se escolhe por ponto.
 */
import type { MotivoComRede, MotivoDaAusencia } from "./cliente";
import { TAREFA_DO_CLIMA } from "./tarefas";

export function codigoDoErroDoJev<M extends MotivoDaAusencia>(motivo: M): `jev_${M}` {
  return `jev_${motivo}`;
}

/**
 * Os motivos em que nada saiu para a rede. Só viram linha na cobertura do
 * roteador decidindo (`./roteador.ts`) — a IA de sempre escolheu no lugar de um
 * Jev que nem foi perguntado — e nunca são a "Última falha" do cartão: não são
 * falha nova, e a que abriu o disjuntor é a que diz o que fazer.
 */
export const CODIGOS_SEM_REDE: ReadonlySet<string> = new Set([
  codigoDoErroDoJev("sem_credencial"),
  codigoDoErroDoJev("disjuntor_aberto"),
]);

export const O_QUE_FAZER_DO_JEV: Readonly<Record<`jev_${MotivoDaAusencia}`, string>> = {
  jev_credencial_invalida:
    "A TypeSafe não aceitou a chave do Jev. Confira em Credenciais se ela ainda vale, ou cole uma nova.",
  jev_sem_credito:
    "A TypeSafe recusou o pedido do Jev, em geral por crédito esgotado. Confira o saldo na sua conta da TypeSafe.",
  jev_contrato_invalido:
    "O sistema fez ao Jev uma pergunta que ele não aceitou. É defeito nosso, não da sua configuração: avise o suporte.",
  jev_limite_de_taxa:
    "O Jev recebeu pedidos demais de uma vez e pediu uma pausa. Ele volta sozinho em alguns minutos.",
  jev_provedor_sobrecarregado:
    "O Jev está sobrecarregado neste momento. Costuma se resolver sozinho em alguns minutos.",
  jev_provedor_indisponivel: "O Jev não respondeu a tempo ou está fora do ar. Costuma se resolver sozinho.",
  jev_resposta_ilegivel:
    "O Jev respondeu de um jeito que o sistema não entendeu. Se continuar acontecendo, avise o suporte.",
  jev_sem_credencial:
    "O Jev está ligado, mas sem uma chave que passou no teste: ele nem foi perguntado. Confira a chave dele em Credenciais.",
  jev_disjuntor_aberto:
    "O Jev falhou há pouco e ficou alguns minutos sem ser perguntado, para não atrasar o atendimento. Ele volta sozinho.",
};

/**
 * O "por que este modelo" das linhas de FALHA do Jev em Execuções. São duas, e
 * a frase da origem ("O Jev decidiu.", "O Jev observou…") seria falsa nas duas:
 *
 *  - origem `jev`: o clima, quando ninguém mediu — a falha tem consequência;
 *  - origem `jev_observacao`: uma tarefa do turno (a manipulação, o roteador —
 *    `./pool.ts`). A falha que pede ação vira linha para a "Última falha" do
 *    cartão, mas nada dependia só do Jev: a IA de sempre decidiu (observando,
 *    ou decidindo como reserva do roteador), ou, sem ela, a regra de antes
 *    (R2). A tela não pode afirmar consequência nenhuma — nem que ele "só
 *    opina": no roteador, decidindo, ele decide. Nem que houve atendimento: a
 *    tela "Testar classificação" do roteador grava a mesma linha, e um clique
 *    de teste não atende ninguém.
 */
export const JEV_FALHOU_SEM_RESERVA =
  "O Jev estava ligado e não respondeu, e não havia outra IA para medir no lugar dele.";
export const JEV_FALHOU_AO_LADO =
  "O Jev não respondeu, e nada dependia só dele: valeu o que a sua IA de sempre decidiu ou, sem ela, a regra de antes.";
/**
 * A linha de erro do Jev no roteador DECIDINDO, quando a IA de sempre cobriu
 * (origem `reserva_do_jev`, `./roteador.ts`): a falha teve consequência — a
 * escolha do agente foi a dela, e não a dele.
 */
export const JEV_FALHOU_E_A_IA_COBRIU = "O Jev decide esta tarefa e não respondeu: a sua IA de sempre decidiu no lugar dele.";

/**
 * O que o diálogo de exclusão diz sobre a chave que o Jev usa — frase a frase,
 * cada uma traduzida sozinha (`avisoAoExcluirAChaveDoJev`).
 */
export const AO_EXCLUIR_A_CHAVE_DO_JEV = {
  outraChave: "O Jev usa esta chave. Sem ela, ele passa a usar a outra chave dele que já passou no teste.",
  usada: "O Jev usa esta chave. Sem ela, o Jev é desligado e as tarefas em “Usada em” param.",
  nenhumaTarefa: "O Jev está ligado, mas nenhuma tarefa dele usa esta chave agora. Sem ela, o Jev é desligado.",
  climaComIa: "O clima da conversa volta a ser medido só pela sua IA principal.",
  climaSemIa: "O clima da conversa deixa de ser medido: ninguém da equipe é chamado quando um cliente se irrita.",
} as const;

/**
 * O aviso, a partir das tarefas que a chave SERVE agora — as mesmas do "Usada
 * em" (`app/app/ai/credentials/page.tsx`, por rótulo). Antes ele olhava só a
 * chave e a IA principal: com o clima pausado, afirmava que "o clima deixa de
 * ser medido", um efeito que já valia, e dizia "O Jev usa esta chave" com o
 * "Usada em" vazio. Sobrando outra chave apta, o Jev não desliga.
 */
export function avisoAoExcluirAChaveDoJev(c: {
  temOutraChave: boolean;
  tarefas: readonly string[];
  temIaPrincipal: boolean;
}): string[] {
  const t = AO_EXCLUIR_A_CHAVE_DO_JEV;
  if (c.temOutraChave) return [t.outraChave];
  if (c.tarefas.length === 0) return [t.nenhumaTarefa];
  if (!c.tarefas.includes(TAREFA_DO_CLIMA.rotulo)) return [t.usada];
  return [t.usada, c.temIaPrincipal ? t.climaComIa : t.climaSemIa];
}

/**
 * O aviso da Central, para falha que não passa sozinha (`exigeAcao`) e, sem IA
 * de linguagem, para a que deveria passar e não passou. O título é FIXO porque
 * é a chave do dedupe (`./aviso.ts`): uma chave recusada vira UM aviso, não um
 * por mensagem do dia. E é do Jev, não do clima: a chave recusada para toda
 * tarefa dele de uma vez.
 */
export const AVISO_DO_JEV = {
  titulo: "O Jev parou de funcionar",
  comReserva: "Enquanto isso, a IA de sempre mede o clima no lugar dele.",
  semReserva:
    "Enquanto isso, o clima não está sendo medido: ninguém da equipe é chamado quando um cliente se irrita.",
  /**
   * A falha que costuma passar sozinha e não passou, sem IA de linguagem para
   * medir no lugar dele: sem esta frase, o clima ficava parado sem nada na tela.
   */
  quedaSustentada:
    "Já foram várias falhas seguidas. O sistema segue tentando sozinho; se continuar assim, confira na sua conta da TypeSafe se o serviço do Jev está no ar.",
  rearme: "Este aviso se fecha sozinho quando o Jev voltar a medir.",
} as const;

/**
 * Títulos que este aviso já teve. Continuam na busca de `./aviso.ts`: o aviso
 * aberto com um deles numa instalação que atualizou é o MESMO aviso — é
 * atualizado para o título de agora e se fecha quando o Jev volta. Só cresce.
 */
export const TITULOS_ANTIGOS_DO_AVISO_DO_JEV: readonly string[] = ["O Jev parou de medir o clima das conversas"];

export function avisoDoJevNaCentral(
  motivo: MotivoComRede,
  temReserva: boolean,
  traduzirTexto: (texto: string) => string,
  quedaSustentada = false,
): { title: string; body: string } {
  return {
    title: traduzirTexto(AVISO_DO_JEV.titulo),
    body: [
      O_QUE_FAZER_DO_JEV[codigoDoErroDoJev(motivo)],
      temReserva ? AVISO_DO_JEV.comReserva : AVISO_DO_JEV.semReserva,
      ...(quedaSustentada ? [AVISO_DO_JEV.quedaSustentada] : []),
      AVISO_DO_JEV.rearme,
    ]
      .map(traduzirTexto)
      .join(" "),
  };
}
