/**
 * O vocabulário AGNÓSTICO do eixo de plataformas de anúncio.
 *
 * ─── Por que esta fronteira existe, ao lado de `lib/channels/` ──────────────
 *
 * A doutrina de restrição de canal (`docs/doctrine/restricao-de-canal.md`,
 * invariante 1) diz que nenhuma feature nomeia um provider. `lib/channels/` é a
 * fronteira onde os nomes podem viver — mas CANAL, nesta casa, é o que ENTREGA
 * MENSAGEM a um contato, e é governado por capabilities que descrevem o que a
 * plataforma permite dizer: janela de 24h, template aprovado, risco de ban,
 * intervalo mínimo por destinatário.
 *
 * Reportar conversão não tem nenhuma dessas físicas. Não há janela, não há
 * template, não há ban, não há destinatário. Uma linha em `CHANNEL_CAPABILITIES`
 * que respondesse "não se aplica" às sete colunas afirmaria que isto é canal
 * quando não é — e o invariante 2 (toda restrição declara ORIGEM e FÍSICA)
 * viraria formulário preenchido com nada.
 *
 * E há o motivo concreto, que é o que decide: os dois eixos são INDEPENDENTES.
 * Uma organização pode receber lead de anúncio clique-para-WhatsApp num número
 * servido por qualquer transporte de mensagem. Pendurar conversões em
 * `lib/channels/` amarraria "reportar venda" a "ter canal oficial conectado".
 *
 * Então: segunda fronteira, mesma natureza, mesma catraca. `scripts/lint-channels.ts`
 * ganhou uma entrada em `ALLOWED` para este diretório — não uma exceção de
 * feature, que é o que o lint existe para impedir.
 *
 * ─── O que NÃO pode aparecer fora daqui ─────────────────────────────────────
 *
 * O nome do endpoint, o formato do payload, o nome dos campos da plataforma.
 * `meta_ads` PODE: é o slug da plataforma no vocabulário que a 0164 já criou
 * (`PlataformaDeAnuncio` em `lib/leads/atribuicao-de-anuncio.ts`), e o padrão de
 * `scripts/lint-channels.pattern.ts` não o proíbe — ele proíbe nome de
 * TRANSPORTE (`meta_cloud`, `graph.facebook.com`), que é outra coisa.
 */

/**
 * A plataforma que hospeda o anúncio.
 *
 * Declarado aqui e não importado de `lib/leads/`: a feature descreve a
 * atribuição que ela CAPTUROU; esta fronteira descreve para onde se pode
 * REPORTAR. Os dois conjuntos coincidem hoje e não têm por que coincidir sempre
 * — existe plataforma que atribui e não recebe conversão de volta.
 */
export type PlataformaDeAnuncio = "meta_ads" | "google_ads";

/** Só `Purchase` hoje. `Lead` é a Fase 2 e entra quando `lead.created` for consumido. */
export type NomeDoEvento = "Purchase";

/**
 * Uma conversão pronta para sair — no formato da CASA, não no da plataforma.
 *
 * Quem monta isto (`lib/conversoes/`) não sabe que campo vira o quê no fio. Quem
 * traduz (o transporte) não sabe de onde veio nem por que foi decidido enviar.
 */
export interface ConversaoOffline {
  organizationId: string;
  leadId: string;
  evento: NomeDoEvento;
  /**
   * Deduplicação, determinística: `<leadId>:<evento>`.
   *
   * A plataforma descarta a segunda cópia com o mesmo par (id, evento). É a
   * SEGUNDA camada — a primeira é o índice único do livro-razão. Duas porque
   * contar a mesma venda duas vezes envenena o otimizador e não tem sintoma:
   * o algoritmo passa a perseguir um público que comprou metade do que parece.
   */
  eventoId: string;
  /**
   * QUANDO a venda aconteceu (o `closed_at` do lead), nunca quando o worker
   * acordou. A plataforma recusa evento velho demais, e carimbar `now()` faria
   * um backlog de drain virar atribuição errada em vez de erro visível.
   */
  ocorridoEm: Date;
  /** O clique que originou a conversa — `ad_source_id` do contato (0164). */
  cliqueDeOrigem: string;
  /** E.164 sem `+`, ainda EM CLARO: o hash é responsabilidade do transporte. */
  telefone: string | null;
  valorCentavos: number;
  moeda: string;
}

/**
 * O resultado, com a FÍSICA da falha declarada — não um booleano.
 *
 * Invariante 2 da doutrina: a origem da restrição decide o que fazer quando ela
 * barra. Aqui isso vira três desfechos com tratamentos que não se substituem:
 *
 *  - `ok`          → gravado como enviado, nunca reenviado.
 *  - `transitorio` → rede, 5xx, throttle. O drain reagenda SEM contar tentativa;
 *                    amanhã funciona sozinho e ninguém precisa ser avisado.
 *  - `permanente`  → token inválido, dataset errado, evento velho demais.
 *                    Reagendar não conserta: alguém tem de mexer na configuração.
 *                    Vira linha `error` no livro-razão, que a tela mostra.
 *
 * Fundir os dois últimos em "falhou" produziria ou retry infinito de um problema
 * humano, ou alarme para uma instabilidade que se resolve sozinha. Os dois erros
 * já foram cometidos nesta casa em outros módulos.
 */
export type ResultadoDeEnvio =
  | { tipo: "ok"; detalhe?: string }
  | { tipo: "transitorio"; detalhe: string; tentarEmMs?: number }
  | { tipo: "permanente"; detalhe: string };

/** As credenciais que o transporte precisa, já decifradas. */
export interface CredencialDeConversao {
  datasetId: string;
  accessToken: string;
  /** Preenchido = envio marcado como teste, não conta para otimização. */
  testEventCode: string | null;
}

/**
 * O contrato que todo transporte de conversão cumpre.
 *
 * `google_ads` não implementa nenhum hoje — e a ausência é DECLARADA no
 * registry, não deduzida do silêncio (invariante 4).
 */
export interface TransporteDeConversao {
  plataforma: PlataformaDeAnuncio;
  enviar(
    credencial: CredencialDeConversao,
    conversao: ConversaoOffline,
  ): Promise<ResultadoDeEnvio>;
}
