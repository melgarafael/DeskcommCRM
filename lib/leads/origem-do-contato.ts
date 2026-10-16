/**
 * OS QUATRO NÍVEIS DA ORIGEM, LIDOS DE UM JSONB QUE TEM DOIS VOCABULÁRIOS.
 *
 * ─── Por que existe uma tabela de precedência, e não um acesso direto ───────
 *
 * `contacts.source_metadata` é alimentado por DOIS caminhos, que gravam a mesma
 * coisa com nomes diferentes — e nenhum dos dois está errado:
 *
 *   - **site/LP** achata as UTMs cruas (`utm_campaign`, `utm_adset`, …), porque
 *     é isso que a página mandou e renomear ali perderia o nome que quem montou
 *     o link escolheu;
 *   - **clique-para-WhatsApp** grava o que a plataforma de anúncio devolve
 *     (`ad_title` hoje; `campaign_name`, `adset_name` e `ad_name` quando a
 *     resolução da hierarquia existir), porque o anúncio não passa por URL
 *     nenhuma e não há UTM para ler.
 *
 * Uma tela que lesse só um dos dois mostraria metade dos contatos vazia. Uma que
 * escolhesse por caminho ("veio de anúncio? então…") precisaria descobrir o
 * caminho, que é justamente o que o metadata não diz de forma confiável. Então a
 * regra é por CAMPO: a primeira chave que tiver valor vence, e a ordem coloca a
 * UTM na frente porque ela é o que o operador escreveu — o nome da plataforma é
 * o que sobra quando ninguém escreveu nada.
 *
 * ─── Posicionamento não existe no clique-para-WhatsApp ──────────────────────
 *
 * A Meta expõe *placement* só em breakdown de insights AGREGADO, nunca por
 * clique individual. Não é dado faltando: é dado que não existe na origem, e
 * nenhuma implementação nossa o produz. Por isso `semPosicionamentoDeAnuncio`
 * sai daqui — a tela precisa dizer isso ao lado do campo vazio, ou quem opera
 * vai procurar um defeito que não há.
 */

/**
 * `contacts.source` de quem entrou pelo "Sincronizar agenda do celular" (#2736).
 * Mora aqui, e não no serviço da agenda, porque a ficha e o filtro de origem
 * (telas de cliente) também a leem, e aquele módulo é de servidor.
 */
export const ORIGEM_AGENDA_DO_CELULAR = "whatsapp_agenda";

/** As chaves que respondem "de onde veio", antes de cair na coluna `source`. */
const CHAVES_DA_ORIGEM = ["utm_source", "ad_platform"] as const;

export interface OrigemDoContato {
  /** Nunca vazio: cai na coluna `source` do contato quando o jsonb não diz. */
  origem: string;
  /**
   * Os três níveis abaixo da origem, e o posicionamento. `null` quando o dado
   * não chegou — a ficha esconde a linha em vez de mostrar um travessão.
   *
   * São quatro campos nomeados, e não uma lista de `{ rotulo, valor }`, porque
   * o rótulo pertence à TELA: uma lista faria a ficha chamar `t(nivel.rotulo)`,
   * e `t()` com argumento não literal escapa do guardião de espanhol — a tabela
   * inteira poderia ficar sem tradução com o teste verde (issue #603).
   */
  campanha: string | null;
  conjunto: string | null;
  anuncio: string | null;
  posicionamento: string | null;
  /**
   * O contato veio de anúncio e o posicionamento não existe para ele.
   *
   * Falso quando não veio de anúncio (não há o que explicar) e falso quando o
   * posicionamento chegou pela URL (não há ausência para explicar).
   */
  semPosicionamentoDeAnuncio: boolean;
}

/** Texto não vazio, ou `null`. Número e booleano no jsonb não são rótulo. */
function texto(valor: unknown): string | null {
  return typeof valor === "string" && valor.trim() !== "" ? valor.trim() : null;
}

function primeiro(
  metadata: Record<string, unknown>,
  chaves: readonly string[],
): string | null {
  for (const chave of chaves) {
    const valor = texto(metadata[chave]);
    if (valor) return valor;
  }
  return null;
}

export function origemDoContato(
  metadata: Record<string, unknown> | null | undefined,
  source: string,
): OrigemDoContato {
  const meta = metadata && typeof metadata === "object" ? metadata : {};
  const posicionamento = primeiro(meta, ["utm_placement"]);

  // "Veio de anúncio" é o que a `fn_estampar_atribuicao_de_anuncio` carimbou, e
  // não a presença de UTM: `ad_platform: "site"` é origem de site, que TEM
  // posicionamento quando a URL o trouxe. Só o clique-para-WhatsApp é o caso sem
  // o dado na origem.
  const plataforma = texto(meta.ad_platform);
  const deAnuncio = plataforma !== null && plataforma !== "site";

  return {
    origem: primeiro(meta, CHAVES_DA_ORIGEM) ?? source,
    campanha: primeiro(meta, ["utm_campaign", "campaign_name"]),
    conjunto: primeiro(meta, ["utm_adset", "adset_name"]),
    anuncio: primeiro(meta, ["utm_ad", "ad_name", "ad_title"]),
    posicionamento,
    semPosicionamentoDeAnuncio: deAnuncio && posicionamento === null,
  };
}
