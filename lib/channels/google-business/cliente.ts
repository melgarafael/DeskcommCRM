/**
 * O cliente HTTP das avaliações — só o transporte.
 *
 * ─── Por que `buscar` é injetável ──────────────────────────────────────────
 *
 * É o que separa "o CRM mostra a avaliação" de "o Google respondeu". A prova
 * de unidade mede o que SAI (URL, verbo, cabeçalho) e o que ENTRA (o JSON vira
 * item na Central) sem tocar na rede — mesma disciplina de
 * `lib/channels/social/client.ts`, que recebe o `fetch` do chamador.
 *
 * ⚠️ O formato de resposta aqui é o do My Business API v4
 * (`accounts.locations.reviews`), documentado em
 * developers.google.com/my-business/reference/rest/v4/accounts.locations.reviews.
 * O que NÃO está provado por suíte nenhuma deste repositório: a resposta de um
 * projeto Google aprovado — a aprovação ("Application for Basic API Access")
 * é por projeto e não existe em ambiente de teste. Todo consumo real desta
 * fatia é, portanto, DUBLADO, e a fatia 2/3 é que mede contra o provedor.
 */

const BASE_PADRAO = "https://mybusiness.googleapis.com/v4";
const TAMANHO_DA_PAGINA = 50;
/** Teto de páginas: 10 × 50 = 500 avaliações por sincronização. */
const MAXIMO_DE_PAGINAS = 10;

export class ErroDaLeituraDeAvaliacoes extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "ErroDaLeituraDeAvaliacoes";
  }
}

export interface PedidoDeAvaliacoes {
  /** `accounts/{conta}/locations/{local}`. */
  escopo: string;
  /** Token de acesso do projeto Google da organização. */
  token: string;
  /** Injetável para a prova de unidade; o padrão é o `fetch` do runtime. */
  buscar?: typeof fetch;
  base?: string;
}

/**
 * Lista as avaliações do escopo, seguindo `nextPageToken`.
 *
 * Devolve os objetos CRUS: quem decide o que é uma avaliação legível é
 * `lerAvaliacoes`, e misturar as duas responsabilidades faria o filtro de
 * escopo depender do transporte.
 */
export async function listarAvaliacoesDoEscopo(pedido: PedidoDeAvaliacoes): Promise<unknown[]> {
  const escopo = pedido.escopo.replace(/^\/+|\/+$/g, "");
  const token = pedido.token.trim();
  if (!escopo) throw new ErroDaLeituraDeAvaliacoes("Escopo de avaliações ausente.");
  if (!token)
    throw new ErroDaLeituraDeAvaliacoes(
      "Sem token de acesso do projeto Google: a leitura não pode ser feita.",
      401,
    );

  const buscar = pedido.buscar ?? fetch;
  const base = (pedido.base ?? BASE_PADRAO).replace(/\/+$/, "");
  const itens: unknown[] = [];
  let pagina: string | null = null;

  for (let indice = 0; indice < MAXIMO_DE_PAGINAS; indice += 1) {
    const parametros = new URLSearchParams({ pageSize: String(TAMANHO_DA_PAGINA) });
    if (pagina) parametros.set("pageToken", pagina);
    const url = `${base}/${escopo}/reviews?${parametros.toString()}`;

    const resposta = await buscar(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });

    if (!resposta.ok) {
      // 401/403 são o token vencido/recusado — o chamador transforma isso em
      // "a credencial foi recusada", com o número do status, em vez de
      // derrubar a tela.
      throw new ErroDaLeituraDeAvaliacoes(
        `O Google recusou a leitura das avaliações (HTTP ${resposta.status}).`,
        resposta.status,
      );
    }

    const corpo = (await resposta.json().catch(() => null)) as unknown;
    if (corpo === null || typeof corpo !== "object") {
      throw new ErroDaLeituraDeAvaliacoes("A resposta do Google não é um objeto legível.", 502);
    }
    const registro = corpo as Record<string, unknown>;
    if (Array.isArray(registro.reviews)) itens.push(...registro.reviews);
    const proxima = registro.nextPageToken;
    pagina = typeof proxima === "string" && proxima.length > 0 ? proxima : null;
    if (!pagina) break;
  }

  return itens;
}
