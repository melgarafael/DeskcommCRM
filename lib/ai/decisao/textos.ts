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
import type { MotivoComRede } from "./cliente";

export function codigoDoErroDoJev(motivo: MotivoComRede): `jev_${MotivoComRede}` {
  return `jev_${motivo}`;
}

export const O_QUE_FAZER_DO_JEV: Readonly<Record<`jev_${MotivoComRede}`, string>> = {
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
};

/**
 * O "por que este modelo" da linha de FALHA do Jev em Execuções — a única que
 * ele grava, quando ninguém mediu. A frase da origem `jev` ("O Jev decidiu.")
 * seria falsa justamente nela.
 */
export const JEV_FALHOU_SEM_RESERVA =
  "O Jev estava ligado e não respondeu, e não havia outra IA para medir no lugar dele.";

/**
 * O que o diálogo de exclusão diz sobre a chave que o Jev usa. São três
 * desfechos, e a frase única de antes era falsa em dois: sobrando outra chave
 * apta, o Jev não desliga; sem IA principal, ninguém volta a medir o clima.
 */
export const AO_EXCLUIR_A_CHAVE_DO_JEV = {
  outraChave: "O Jev usa esta chave. Sem ela, ele passa a usar a outra chave dele que já passou no teste.",
  iaPrincipalAssume:
    "O Jev usa esta chave. Sem ela, o Jev é desligado e o clima da conversa volta a ser medido só pela sua IA principal.",
  climaPara:
    "O Jev usa esta chave. Sem ela, o Jev é desligado e o clima da conversa deixa de ser medido: ninguém da equipe é chamado quando um cliente se irrita.",
} as const;

/**
 * O aviso da Central, para falha que não passa sozinha (`exigeAcao`) e, sem IA
 * de linguagem, para a que deveria passar e não passou. O título é FIXO porque é a chave do dedupe: uma chave recusada vira UM aviso,
 * não um por mensagem do dia.
 */
export const AVISO_DO_JEV = {
  titulo: "O Jev parou de medir o clima das conversas",
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
