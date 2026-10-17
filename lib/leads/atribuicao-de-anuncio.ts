/**
 * Atribuição de anúncio — de qual campanha um contato veio.
 *
 * Este arquivo é a parte AGNÓSTICA: o formato do dado atribuído e a gravação
 * dele no contato. Quem sabe ler o payload é o transporte, cada um no seu
 * módulo — é a doutrina de restrição de canal (`docs/doctrine/restricao-de-canal.md`,
 * invariante 1: nenhuma feature nomeia um provider), e o `pnpm lint:channels`
 * reprova quem a quebra.
 *
 * Os extratores vivem um por transporte, cada um na pasta do seu canal —
 * `atribuicao-de-anuncio-oficial.ts` para o `referral` do webhook da API
 * oficial, e o homônimo na pasta do transporte por QR para o mesmo dado quando
 * ele vem embutido na própria mensagem. Procure por `extrairAtribuicao` para
 * achar os dois; citar o caminho aqui é justamente o que o invariante proíbe.
 *
 * Não há extrator de Google Ads: não existe mecanismo nativo equivalente para
 * WhatsApp. Aquele caminho depende de uma landing page que capture o `gclid` e
 * embuta um código de rastreio na mensagem pré-preenchida, e essa LP ainda não
 * existe.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

export type PlataformaDeAnuncio = "meta_ads" | "google_ads";

export interface AtribuicaoDeAnuncio {
  plataforma: PlataformaDeAnuncio;
  /** `ctwa_clid` — identifica o clique específico que abriu a conversa. */
  sourceId: string | null;
  /**
   * O ANÚNCIO, que não é o clique.
   *
   * Existe como campo próprio porque os dois vinham disputando `sourceId`: o
   * extrator preferia o `ctwa_clid` e caía para o id do anúncio só na ausência
   * dele, então o payload que trazia os DOIS perdia o segundo em silêncio — ele
   * sobrevivia só dentro de `bruto`, que ninguém consulta para responder "de
   * qual anúncio veio". Um clique identifica uma pessoa numa hora; um anúncio
   * identifica a peça que milhares de pessoas viram. São perguntas diferentes,
   * e é o anúncio que tem nome, conjunto e campanha para resolver depois.
   */
  adId: string | null;
  /** Título/headline do anúncio, quando o payload o traz. */
  titulo: string | null;
  corpo: string | null;
  sourceUrl: string | null;
  /**
   * A imagem do anúncio, quando o payload a traz. Opcional porque nem todo
   * extrator a conhece; quem não traz fica sem miniatura, nunca sem atribuição.
   */
  miniatura?: string | null;
  /** Payload de onde isto foi extraído — nunca descartado, é a prova. */
  bruto: Record<string, unknown>;
}

export type Bruto = Record<string, unknown>;
export const obj = (v: unknown): Bruto | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Bruto) : null;
export const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v : null;

/**
 * Só `https:`. O endereço vem de fora (o payload do anúncio) e vai parar num
 * `href` e num `src` da inbox: `javascript:` ou `data:` ali seriam código ou
 * conteúdo arbitrário dentro da tela de quem atende.
 */
export function urlSegura(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  try {
    return new URL(s).protocol === "https:" ? s : null;
  } catch {
    return null;
  }
}

/**
 * O anúncio de UMA mensagem — o que fica em `messages.metadata.anuncio`.
 *
 * ─── Por que a mensagem também guarda, se o contato já guarda ──────────────
 *
 * O contato guarda só o PRIMEIRO anúncio (ver `estamparAtribuicaoDoContato`, e
 * isso não muda). Numa loja com dois produtos, cada um com o seu anúncio, a
 * pessoa que veio pelo anúncio A e semanas depois clica no anúncio B chega com
 * o texto pré-preenchido genérico ("Qual é o preço?") — e quem atende, olhando
 * só o anúncio A, responde sobre o produto errado. O clique novo precisa deixar
 * rastro em algum lugar, e o lugar natural é a mensagem que ele gerou.
 *
 * Resumo COMPACTO de propósito: título, texto e id do anúncio, mais os dois
 * endereços que a inbox precisa para MOSTRAR o anúncio na conversa (o link e a
 * miniatura). O clique (`ctwa_clid`) e o payload cru ficam de fora — o cru já
 * mora no contato, e repeti-lo em toda mensagem de anúncio só engordaria a
 * tabela mais quente do banco. O id serve à comparação (`mesmoAnuncio`); os
 * endereços, à tela.
 */
export interface AnuncioDaMensagem {
  titulo: string | null;
  texto: string | null;
  ad_id: string | null;
  /** Link do anúncio (o `source_url` do clique), só `https:`. */
  url?: string | null;
  /** Imagem do anúncio, só `https:`. A da Meta expira dias depois. */
  miniatura?: string | null;
}

/**
 * O pedaço de `metadata` que a ingestão espalha no INSERT da mensagem —
 * `{ anuncio }` quando a mensagem veio de um anúncio reconhecido, `{}` quando
 * não. Cada transporte chama o SEU extrator e passa o resultado aqui: quem lê o
 * payload é o canal; o formato gravado é um só.
 */
export function metadataDoAnuncio(
  atribuicao: AtribuicaoDeAnuncio | null,
): { anuncio?: AnuncioDaMensagem } {
  if (!atribuicao) return {};
  const anuncio: AnuncioDaMensagem = { titulo: atribuicao.titulo, texto: atribuicao.corpo, ad_id: atribuicao.adId };
  // Sem título, texto nem id não há o que comparar nem o que mostrar: o clique
  // sozinho identifica uma pessoa, não um produto.
  if (!anuncio.titulo && !anuncio.texto && !anuncio.ad_id) return {};
  const url = urlSegura(atribuicao.sourceUrl);
  const miniatura = urlSegura(atribuicao.miniatura);
  if (url) anuncio.url = url;
  if (miniatura) anuncio.miniatura = miniatura;
  return { anuncio };
}

/**
 * Lê `metadata.anuncio` de volta — sem confiar na forma.
 *
 * `metadata` é jsonb aberto: linha antiga, escrita à mão ou de outra versão
 * pode trazer qualquer coisa ali. Quem lê (a bolha da conversa, o painel) não
 * pode lançar por causa disso; o que não tem a forma esperada vira `null`.
 */
export function lerAnuncioDaMensagem(v: unknown): AnuncioDaMensagem | null {
  const a = obj(v);
  if (!a) return null;
  const anuncio = { titulo: str(a.titulo), texto: str(a.texto), ad_id: str(a.ad_id) };
  if (!anuncio.titulo && !anuncio.texto && !anuncio.ad_id) return null;
  return { ...anuncio, url: urlSegura(a.url), miniatura: urlSegura(a.miniatura) };
}

/**
 * O mesmo anúncio: o mesmo `ad_id`, ou — sem id comparável — o mesmo título e
 * texto. Ids diferentes com o MESMO texto também contam como iguais: é o
 * anúncio duplicado em outro conjunto, e quem lê na inbox veria duas vezes a
 * mesma coisa.
 */
export function mesmoAnuncio(a: AnuncioDaMensagem, b: AnuncioDaMensagem): boolean {
  if (a.ad_id && b.ad_id && a.ad_id === b.ad_id) return true;
  const igual = (x: string | null, y: string | null) => (x?.trim() || null) === (y?.trim() || null);
  return igual(a.titulo, b.titulo) && igual(a.texto, b.texto);
}

/** O anúncio de PRIMEIRO TOQUE do contato, como a inbox o mostra. */
export interface AnuncioDoContato extends AnuncioDaMensagem {
  /** Quando o clique foi gravado no contato (ISO). */
  capturado_em: string | null;
}

/**
 * Lê o anúncio gravado em `contacts.source_metadata` por
 * `estamparAtribuicaoDoContato` — sem confiar na forma, como a irmã acima.
 *
 * A miniatura vem de `ad_thumbnail_url`, que só existe a partir desta versão;
 * contato carimbado antes a tem apenas dentro do payload cru (`ad_raw`), nos
 * dois formatos em que os transportes a entregam. Ler o cru aqui é a única
 * forma de mostrar o anúncio de quem já chegou — e a leitura é só de
 * `thumbnail_url`/`thumbnailUrl`, nunca do payload inteiro.
 */
export function lerAnuncioDoContato(sourceMetadata: unknown): AnuncioDoContato | null {
  const m = obj(sourceMetadata);
  if (!m || !str(m.ad_platform)) return null;
  const titulo = str(m.ad_title);
  const texto = str(m.ad_body);
  const ad_id = str(m.ad_id);
  const url = urlSegura(m.ad_source_url);
  if (!titulo && !texto && !ad_id && !url) return null;
  const cru = obj(m.ad_raw);
  const miniatura =
    urlSegura(m.ad_thumbnail_url) ?? urlSegura(cru?.thumbnail_url) ?? urlSegura(cru?.thumbnailUrl);
  return { titulo, texto, ad_id, url, miniatura, capturado_em: str(m.ad_captured_at) };
}

/**
 * Grava a atribuição no CONTATO — só na primeira vez.
 *
 * Primeiro toque: uma vez gravada, não muda. A pessoa pode clicar em outro
 * anúncio meses depois, numa conversa já aberta — isso não deveria reescrever
 * de onde ela veio ORIGINALMENTE, que é o dado que explica a existência do
 * relacionamento. `fn_estampar_atribuicao_de_anuncio` faz a guarda e o merge
 * de `source_metadata` ATOMICAMENTE no banco (não aqui): duas mensagens quase
 * simultâneas do mesmo contato novo não podem correr a corrida de leitura e
 * escrita em JS e uma pisar na outra.
 * Organização é parâmetro OBRIGATÓRIO (issue #1248). A função é
 * `security definer` e o único limite era o `p_contact` que o chamador mandava
 * — uma chamada de service_role escrevia no contato de QUALQUER organização.
 * O `where` da função passou a casar `organization_id = p_org`: contato de
 * outra organização não casa linha nenhuma, em silêncio, como a guarda de
 * primeiro toque. Sem a organização não há chamada — a assinatura de três
 * argumentos foi derrubada no banco de propósito.
 */
export async function estamparAtribuicaoDoContato(
  admin: SupabaseClient,
  organizationId: string,
  contactId: string,
  atribuicao: AtribuicaoDeAnuncio,
): Promise<void> {
  const { error } = await admin.rpc("fn_estampar_atribuicao_de_anuncio" as never, {
    p_org: organizationId,
    p_contact: contactId,
    p_platform: atribuicao.plataforma,
    p_metadata: {
      ad_platform: atribuicao.plataforma,
      ad_source_id: atribuicao.sourceId,
      ad_id: atribuicao.adId,
      ad_title: atribuicao.titulo,
      ad_body: atribuicao.corpo,
      ad_source_url: atribuicao.sourceUrl,
      ad_thumbnail_url: atribuicao.miniatura ?? null,
      ad_raw: atribuicao.bruto,
      ad_captured_at: new Date().toISOString(),
    },
  } as never);

  if (error) {
    // `logger.error`, não `console.error`: o DoD proíbe console em código
    // mergeado, e um erro que só existe no stdout do contêiner não chega a
    // ninguém. A falha é tolerada de propósito — perder a atribuição não pode
    // derrubar a entrada da mensagem — mas ela precisa aparecer.
    logger.error("[atribuicao-de-anuncio] falha ao estampar contato", {
      contact_id: contactId,
      plataforma: atribuicao.plataforma,
      detail: error.message.slice(0, 200),
    });
  }
}
