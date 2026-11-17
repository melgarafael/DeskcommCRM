import { tipoDeFalha } from "@/lib/api/retentativa";

/**
 * O QUE A LISTA DIZ QUANDO NÃO CONSEGUIU LER (#4508).
 *
 * ─── O defeito, medido ──────────────────────────────────────────────────────
 *
 * A rota estoura o timeout, o cliente HTTP esgota as tentativas e o erro chega
 * à tela como `DOMException` de nome `TimeoutError` — que NÃO é `ApiError`. O
 * aviso genérico pegava esse objeto, não reconhecia nada e dizia:
 *
 *     "Erro inesperado. Tente novamente."
 *
 * É literalmente o texto do relato da issue. Para quem atende, "inesperado" não
 * diz se é para esperar, se a sessão caiu ou se o pedido está errado — e as
 * três situações pedem ações diferentes. Pior: sem distinguir, a única saída
 * que sobra é recarregar a página, que é justamente onde o operador perde
 * filtro, conversa aberta e posição na lista.
 *
 * ─── A régua usada aqui é a MESMA da retentativa ────────────────────────────
 *
 * `tipoDeFalha` (lib/api/retentativa) classifica a falha uma vez só; esta
 * função só escolhe a FRASE. Frase e decisão de repetir não podem divergir: se
 * um dia o 502 passar a ser transitório, ele continua sendo "servidor" para
 * quem lê — e a frase segue valendo.
 *
 * `t` é PARÂMETRO, e cada ramo chama `t("literal")`: chave montada em runtime
 * não existe em dicionário nenhum e sairia em português para quem escolheu
 * espanhol (a cerca `i18n-espanhol-cobre-a-tela` reprova exatamente isso).
 */
export function textoDaFalhaDaLista(err: unknown, t: (texto: string) => string): string {
  switch (tipoDeFalha(err)) {
    case "tempo_esgotado":
      return t("A consulta das conversas excedeu o tempo limite.");
    case "sem_conexao":
      return t("Não foi possível falar com o servidor. Verifique a conexão.");
    case "servidor":
      return t("O servidor não respondeu agora.");
    case "sessao":
      return t("Sua sessão expirou. Entre de novo.");
    case "permissao":
      return t("Você não tem permissão para ver estas conversas.");
    case "pedido_recusado":
      return t("O pedido da lista de conversas foi recusado.");
    case "desconhecida":
      return t("Erro ao carregar conversas.");
  }
}
