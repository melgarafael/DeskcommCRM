/**
 * O que a tela diz quando o envio do link do Meet é recusado.
 *
 * ## O defeito, medido numa instalação real em 2026-09-12
 *
 * Clicar em "Enviar link ao cliente" ficava **20 segundos** parado e terminava
 * em *"Erro inesperado. Tente novamente."* — a frase mais inútil do produto,
 * sem sequer o identificador da requisição.
 *
 * O banco recusava por um motivo **claro e específico**: `meet_conversation_stale`
 * — o atendimento daquela conversa mudou depois que o link foi criado, então a
 * autorização precisa ser refeita na conversa atual. Reproduzido chamando
 * `fn_meet_action` direto, com a conta real e os dados reais do compromisso.
 *
 * O que acontecia com esse motivo:
 *
 *   1. a rota reconhecia apenas dois SQLSTATE (`40001` e `42501`) e caía no
 *      genérico — HTTP **500**;
 *   2. 500 é status "tente de novo", então o cliente HTTP **repetia 3 vezes**;
 *   3. ~20s depois desistia, e o erro final nem chegava a virar mensagem útil;
 *   4. e o registro no servidor gravava `code: "internal_error"` — **texto fixo
 *      no código**, que apagava o motivo real.
 *
 * Os 20 segundos que o operador cronometrou eram as três tentativas. Não era
 * lentidão: era o sistema insistindo num pedido que o banco já tinha recusado,
 * por um motivo que ele sabia dizer desde o primeiro milissegundo.
 *
 * ## Por que casar pelo NOME, e não só pelo SQLSTATE
 *
 * A função levanta quinze motivos distintos usando `raise exception '<nome>'
 * using errcode='...'`, e vários compartilham o mesmo SQLSTATE: `40001` cobre
 * "o compromisso mudou", "o atendimento mudou" e "o Google precisa de escolha";
 * `42501` cobre "não é o responsável", "falta verificação em duas etapas" e "a
 * conversa não serve". Traduzir pelo SQLSTATE obriga a dizer as três coisas de
 * uma vez — que é como a mensagem antiga acabou virando *"Esta ação exige o
 * responsável pelo compromisso e uma conversa disponível"*, uma frase que não
 * menciona verificação em duas etapas e manda mexer onde talvez não seja.
 *
 * O nome é o que a função escolheu dizer. É ele que carrega a informação.
 */

/**
 * A mensagem do erro, sem o que nao pode sair daqui.
 *
 * ## Por que REDIGIR e nao apagar
 *
 * A primeira versao deste modulo apagava a mensagem inteira do registro, e por
 * um bom motivo: ela pode carregar o LINK DA REUNIAO, e
 * `tests/unit/agenda-meet-routes.test.ts` injeta
 * `https://meet.google.com/secret?token=private` exigindo que o registro nao
 * contenha "secret".
 *
 * So que apagar tudo custou um diagnostico REAL: em 2026-09-13, numa instalacao
 * de verdade, "Enviar link ao cliente" falhou tres vezes seguidas e o registro
 * guardou apenas `code: "internal_error"` e `sqlstate: "undefined"` — nenhum
 * nome conhecido, nenhum SQLSTATE, nenhuma pista. O servidor sabia o que tinha
 * acontecido e nao guardou nada aproveitavel.
 *
 * Sanitizar de menos vaza; sanitizar de mais cega. A saida e tirar os ENDERECOS
 * — que e onde o segredo mora — e deixar o resto da frase, que e onde mora o
 * diagnostico.
 *
 * Tira QUALQUER endereco, nao so os do Meet: um segredo tanto pode estar no
 * caminho quanto na query de um endereco qualquer.
 */
export function semSegredos(mensagem: string | undefined | null): string | null {
  if (!mensagem) return null;
  return mensagem.replace(/https?:\/\/\S+/g, "[link]").slice(0, 300);
}

/** Como a recusa deve chegar a quem clicou. */
export interface MotivoDoMeet {
  /** Código da resposta da API — vira `error.code` no cliente. */
  readonly codigo: string;
  /** HTTP. **Nunca 5xx para recusa conhecida** — ver `naoRepetir` abaixo. */
  readonly status: number;
  /** Em português; quem chama passa pelo `t()` do idioma de quem lê. */
  readonly texto: string;
  /**
   * `true` quando repetir não adianta — e é isto que acaba com os 20 segundos.
   *
   * O cliente repete automaticamente em 5xx. Uma recusa de regra devolvida como
   * 500 vira três tentativas idênticas, três recusas idênticas, e uma espera
   * três vezes maior antes da mesma frase inútil.
   */
  readonly naoRepetir: boolean;
}

/**
 * Os motivos que `fn_meet_action` levanta, traduzidos.
 *
 * Cada frase diz **o que fazer**, não só o que houve: "tente novamente" sozinho
 * convida ao clique imediato, que é o gesto que empilha pedido.
 */
const POR_NOME: Readonly<Record<string, Omit<MotivoDoMeet, "naoRepetir">>> = {
  meet_conversation_stale: {
    codigo: "meet_conversation_stale",
    status: 409,
    texto:
      "O atendimento desta conversa mudou depois que o link foi criado. Escolha a conversa atual e autorize o envio de novo.",
  },
  meet_ocupado: {
    codigo: "meet_ocupado",
    status: 409,
    texto:
      "Este cliente está sendo atendido neste instante. Espere alguns segundos e tente de novo.",
  },
  meet_stale: {
    codigo: "meet_stale",
    status: 409,
    texto: "Este compromisso mudou enquanto a tela estava aberta. Atualize a página e tente de novo.",
  },
  google_conflict_requires_choice: {
    codigo: "google_conflict_requires_choice",
    status: 409,
    texto: "O Google e o CRM discordam sobre este compromisso. Resolva a diferença antes de enviar o link.",
  },
  meet_conversation_unavailable: {
    codigo: "meet_conversation_unavailable",
    status: 403,
    texto:
      "Esta conversa não pode receber o link: ela é de outro contato, é um grupo, ou você não tem acesso a ela.",
  },
  meet_mfa_required: {
    codigo: "mfa_required",
    status: 403,
    texto: "Confirme a verificação em duas etapas nesta sessão para enviar o link.",
  },
  meet_forbidden: {
    codigo: "forbidden",
    status: 403,
    texto: "Só quem é responsável pelo compromisso pode enviar o link dele.",
  },
  meet_action_invalid: {
    codigo: "validation_failed",
    status: 422,
    texto: "Ação desconhecida para o link do Meet.",
  },
};

/** Quando nem o nome nem o SQLSTATE dizem algo conhecido. */
const DESCONHECIDO: MotivoDoMeet = {
  codigo: "internal_error",
  status: 500,
  texto: "Não foi possível registrar a ação. O motivo ficou registrado no servidor com o identificador abaixo.",
  naoRepetir: false,
};

/**
 * Traduz o erro do banco na recusa que a tela mostra.
 *
 * Lê o NOME primeiro (é o que a função escolheu dizer) e só depois cai no
 * SQLSTATE, que é mais grosso. Um erro sem nenhum dos dois vira o genérico —
 * que continua sendo 500 e continua repetindo, de propósito: falha de rede ou
 * de infraestrutura **merece** nova tentativa, ao contrário de recusa de regra.
 */
export function motivoDoMeet(erro: unknown): MotivoDoMeet {
  const e = (erro ?? {}) as { message?: unknown; code?: unknown; details?: unknown };
  const texto = [e.message, e.details].filter((v) => typeof v === "string").join(" ");

  for (const nome of Object.keys(POR_NOME)) {
    // Limites de palavra: sem eles, `meet_stale` casaria dentro de
    // `meet_conversation_stale` conforme a ordem das chaves — e a recusa
    // certa ("o atendimento mudou") viraria a errada ("o compromisso mudou"),
    // mandando a pessoa atualizar a página em vez de escolher a conversa.
    if (new RegExp(`(^|[^a-z_])${nome}([^a-z_]|$)`).test(texto))
      return { ...POR_NOME[nome]!, naoRepetir: true };
  }

  const code = typeof e.code === "string" ? e.code : "";
  if (code === "40001")
    return {
      codigo: "conflict",
      status: 409,
      texto: "O compromisso ou atendimento mudou. Atualize e tente novamente.",
      naoRepetir: true,
    };
  if (code === "42501")
    return {
      codigo: "forbidden",
      status: 403,
      texto: "Esta ação exige o responsável pelo compromisso e uma conversa disponível.",
      naoRepetir: true,
    };
  return DESCONHECIDO;
}
