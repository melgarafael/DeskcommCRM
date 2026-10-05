/**
 * O VOCABULÁRIO DA ENTREGA DO AVISO DE CASO (migration 0292).
 *
 * Duas tuplas, e as duas existem porque o CHECK do banco não é lido pelo
 * compilador: `tests/invariants/vocabulario-banco-x-typescript.test.ts` compara
 * `entregas_de_aviso_de_caso.status` com `STATUS_DA_ENTREGA_DE_AVISO` e
 * `.erro_codigo` com `ERROS_DA_ENTREGA_DE_AVISO`, contra o Postgres que nasce do
 * `baseline.sql`. Os dois pares nascem no MESMO commit da migration — a lição
 * daquela lista é que todo par que divergiu divergiu por ter nascido sozinho.
 *
 * ⚠️ Módulo SEM import de `env`, de client e de rota: ele é lido pelo handler,
 * pela tela da onda 8 e pelo teste, e um import de ambiente aqui arrastaria a
 * validação de `lib/env.ts` para dentro de um teste puro.
 *
 * Por que `erro_codigo` é vocabulário FECHADO e não a mensagem do provedor: o
 * que a tela mostra e o que a Central traduz precisa ser um conjunto conhecido.
 * O texto cru do transporte vai truncado em `erro_detalhe`, que a cascata de
 * LGPD zera — ele é a única coluna desta tabela capaz de ecoar um número.
 */

/** Os quatro estados de uma entrega. `pendente` é o único não-terminal. */
export const STATUS_DA_ENTREGA_DE_AVISO = [
  "pendente",
  "enviado",
  "falhou",
  "cancelado",
] as const;
export type StatusDaEntregaDeAviso = (typeof STATUS_DA_ENTREGA_DE_AVISO)[number];

/**
 * POR QUE a entrega não chegou — um conjunto fechado, cada valor com um dono.
 *
 * `teto_diario_do_numero` existe separado de `expirou` de propósito: um número
 * novo tem cap de 20 envios/dia no warm-up, e sem este código a expiração de um
 * aviso represado pelo cap apareceria como "expirou" genérico — mandando quem
 * investiga procurar no lugar errado.
 *
 * `titular_anonimizado` também é próprio: o aviso NÃO sai, e a razão não é
 * falha nenhuma — é a LGPD alcançando o caso antes de o aviso sair.
 */
export const ERROS_DA_ENTREGA_DE_AVISO = [
  "canal_desconectado",
  "canal_arquivado",
  "canal_nao_aceita_aviso_livre",
  /** O operador PAUSOU a conexão escolhida para os avisos (`metadata.disabled`, migration 0545). */
  "canal_desativado",
  "transporte_ausente",
  "destino_invalido",
  /**
   * O número de destino voltou a ser de uma conexão ATIVA da própria
   * organização.
   *
   * A guarda de "número da própria organização" da 0292 roda só ao DEFINIR o
   * aviso. Uma conexão ARQUIVADA deixa de contar (ela não envia nem recebe), o
   * número dela pode virar destino e, se a conexão for REATIVADA depois,
   * nenhuma checagem volta a rodar — o aviso sairia para um número atendido por
   * um agente desta organização. Este código é o registro da recusa no ENVIO.
   */
  "destino_da_propria_organizacao",
  "teto_diario_do_numero",
  "sem_endereco_publico",
  "titular_anonimizado",
  "expirou",
  "falha_no_envio",
  "indeterminado",
] as const;
export type ErroDaEntregaDeAviso = (typeof ERROS_DA_ENTREGA_DE_AVISO)[number];

/**
 * A frase de gente por código de erro — o que a Central mostra.
 *
 * `satisfies Record<…>` e não anotação solta: um código novo na tupla acima sem
 * frase aqui para de compilar, em vez de virar código cru no rosto de quem opera.
 * As frases entram em `lib/i18n/dicionario.ts` com par `es`.
 */
export const FRASE_DO_ERRO_DO_AVISO = {
  canal_desconectado: "A conexão de WhatsApp escolhida para os avisos está fora do ar.",
  canal_arquivado: "A conexão de WhatsApp escolhida para os avisos foi removida.",
  canal_nao_aceita_aviso_livre:
    "A conexão escolhida só envia mensagens aprovadas — ela não serve para o aviso de caso.",
  canal_desativado:
    "A conexão escolhida para os avisos está pausada. Retome-a na Central de Conexões para os avisos voltarem a sair.",
  transporte_ausente: "O serviço de WhatsApp desta instalação não está configurado.",
  destino_invalido: "O número de aviso não foi aceito pelo WhatsApp.",
  // Sem o número na frase: a configuração é de `admin`, mas a Central é lida
  // por qualquer membro, e o telefone do plantão não é assunto de todos.
  destino_da_propria_organizacao:
    "O número escolhido para os avisos virou o número de uma conexão ativa da sua conta — o aviso não foi enviado.",
  teto_diario_do_numero:
    "O número que envia os avisos atingiu o limite diário do período de aquecimento.",
  sem_endereco_publico:
    "Esta instalação ainda não tem um endereço público — o aviso não teria link para abrir.",
  titular_anonimizado: "O cliente deste atendimento pediu para ser esquecido.",
  expirou: "O aviso ficou mais de 24 horas sem conseguir sair e foi encerrado.",
  falha_no_envio: "O WhatsApp recusou o envio do aviso.",
  indeterminado: "O aviso não saiu e a causa não pôde ser identificada.",
} as const satisfies Record<ErroDaEntregaDeAviso, string>;
