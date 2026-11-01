/**
 * AS RESPOSTAS DO FORMULÁRIO, BUSCADAS NA GRAPH API — a peça que faz o lead real
 * entrar (issue #3768, fatia 1-bis).
 *
 * ═══ POR QUE ESTA CHAMADA EXISTE ════════════════════════════════════════════
 *
 * O aviso de formulário preenchido que a Meta entrega no webhook traz os IDS:
 * `leadgen_id`, `page_id`, `form_id`, `ad_id`, `campaign_id` e o instante. As
 * RESPOSTAS — nome, telefone, e-mail e as demais perguntas — não vêm nele. Quem
 * só lê o corpo do aviso recebe um envelope vazio e um lead que não existe. É
 * esta chamada, autenticada com o token da PÁGINA, que devolve o `field_data` do
 * lead — a mesma forma `{ name, values }` que o aviso às vezes traz embutida.
 *
 * ═══ O QUE ESTA PEÇA NÃO FAZ ════════════════════════════════════════════════
 *
 * **Não inventa dado.** Quando a plataforma não responde — tempo esgotado, erro
 * HTTP, corpo ilegível, `field_data` vazio —, a resposta é uma FALHA NOMEADA, e
 * não um lead com nome de telefone e campos em branco. Um card em branco é pior
 * que um lead ausente: ele ocupa a coluna, alguém liga para um número que talvez
 * nem exista, e a tela mostra "criado" para um dado que ninguém tem. Quem decide
 * o que fazer com a falha é a rota, que a registra por nome.
 *
 * **Não decide se pode chamar.** Ligar a busca é opção da fonte, desligada por
 * padrão (migration 9081, critério da doc 235); quem lê a opção e o token
 * cifrado é a rota. Aqui chega o token já em claro, e só depois de a fonte ter
 * dito que sim.
 *
 * ═══ POR QUE O TOKEN VAI NO CABEÇALHO, E NÃO NA QUERY ═══════════════════════
 *
 * `access_token` na URL é credencial em log de proxy, em `Referer` de erro e em
 * qualquer captura de URL — e este token lê leads de uma página inteira. No
 * cabeçalho `Authorization: Bearer`, ele não entra na URL que o log registra.
 *
 * ═══ POR QUE O TETO DE TEMPO É CURTO ════════════════════════════════════════
 *
 * Quem está do outro lado é o webhook: a plataforma espera a resposta HTTP para
 * decidir se reentrega, e um servidor nosso pendurado numa chamada de rede
 * segura a resposta até o timeout dela. Cinco segundos é folga larga para uma
 * leitura de lead (uma linha, três a vinte respostas) e curto o bastante para a
 * reentrega acontecer ainda nesta janela. Estourou, é `tempo_esgotado` — nomeado,
 * e o lead NÃO entra com dado inventado; a reentrega seguinte tenta de novo.
 */
import { graphBaseUrl } from "@/lib/channels/meta/graph-base";
import { respostasDoFieldData, type RespostaDoFormulario } from "./payload";

/**
 * Teto da chamada. Ver o cabeçalho: curto porque quem espera é o webhook.
 *
 * Exportado para o teste poder medi-lo sem repetir o número — e para quem lê o
 * código achar o valor sem procurar dentro do `if`.
 */
export const TEMPO_LIMITE_DA_BUSCA_MS = 5_000;

/** O que a busca pode não conseguir, cada um com o seu dono. */
export type MotivoDaFalhaNaBusca =
  /** A fonte não ligou a busca (default da coluna). Não é erro: é configuração. */
  | "busca_desligada"
  /** A fonte ligou a busca e não tem token de página colado. */
  | "sem_token_da_pagina"
  /** O token está gravado e esta instalação não consegue decifrá-lo. */
  | "token_indecifravel"
  /** A plataforma não respondeu dentro do teto. */
  | "tempo_esgotado"
  /** A plataforma recusou a chamada (status HTTP fora de 2xx). */
  | "recusada_pela_meta"
  /** Respondeu algo que não é JSON, ou um JSON sem `field_data`. */
  | "resposta_ilegivel"
  /** Respondeu JSON com `field_data` presente e sem nenhuma resposta útil. */
  | "sem_respostas";

export type ResultadoDaBusca =
  | { ok: true; respostas: RespostaDoFormulario[] }
  /**
   * `detalhe` é diagnóstico CURTO e sem PII: o status HTTP, o código de erro do
   * corpo, o nome da exceção de rede. Nunca o corpo da resposta (ele carrega as
   * respostas de alguém) e nunca o token.
   */
  | { ok: false; motivo: MotivoDaFalhaNaBusca; detalhe?: string };

export interface PedidoDaBusca {
  leadgenId: string;
  /** Token de página em claro — a rota o decifra antes de chamar. */
  token: string;
}

/**
 * Lê o lead na Graph API. Nunca lança: falha de rede é desfecho nomeado.
 *
 * O `fetch` é injetável (`opcoes.fetchImpl`) porque esta é a única peça da porta
 * com rede: sem o ponto de injeção, o teste teria de dublar o `fetch` global e
 * mediria o dublê do ambiente, não o contrato desta função.
 */
export async function buscarRespostasDoLead(
  pedido: PedidoDaBusca,
  opcoes: { fetchImpl?: typeof fetch; tempoLimiteMs?: number } = {},
): Promise<ResultadoDaBusca> {
  const token = pedido.token.trim();
  if (token === "") return { ok: false, motivo: "sem_token_da_pagina" };
  if (pedido.leadgenId.trim() === "") return { ok: false, motivo: "resposta_ilegivel", detalhe: "leadgen_id vazio" };

  const buscar = opcoes.fetchImpl ?? fetch;
  const limite = opcoes.tempoLimiteMs ?? TEMPO_LIMITE_DA_BUSCA_MS;
  // `fields` explícito: sem ele o padrão da plataforma muda sem aviso, e o que
  // esta peça precisa é de UM campo só.
  const url = `${graphBaseUrl()}/${encodeURIComponent(pedido.leadgenId)}?fields=field_data`;

  let resposta: Response;
  try {
    resposta = await buscar(url, {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      // O teto anda junto do pedido: se a plataforma pendurar, a conexão morre
      // com esta chamada, e não com a resposta HTTP do webhook.
      signal: AbortSignal.timeout(limite),
      cache: "no-store",
    });
  } catch (erro) {
    // `AbortSignal.timeout` estoura como `TimeoutError`; um abort externo vem
    // como `AbortError`. Os dois são "não respondeu a tempo" para quem chama.
    const nome = erro instanceof Error ? erro.name : "";
    if (nome === "TimeoutError" || nome === "AbortError") {
      return { ok: false, motivo: "tempo_esgotado", detalhe: `${limite}ms` };
    }
    return {
      ok: false,
      motivo: "tempo_esgotado",
      detalhe: erro instanceof Error ? erro.message.slice(0, 120) : "falha de rede",
    };
  }

  if (!resposta.ok) {
    // O status é o diagnóstico que quem opera precisa ("401 = token vencido",
    // "400 = leadgen_id de outra página"), e ele não é PII.
    return { ok: false, motivo: "recusada_pela_meta", detalhe: `http_${resposta.status}` };
  }

  let corpo: unknown;
  try {
    corpo = (await resposta.json()) as unknown;
  } catch {
    return { ok: false, motivo: "resposta_ilegivel", detalhe: "json_invalido" };
  }
  if (!corpo || typeof corpo !== "object" || Array.isArray(corpo)) {
    return { ok: false, motivo: "resposta_ilegivel", detalhe: "corpo_nao_objeto" };
  }
  const fieldData = (corpo as { field_data?: unknown }).field_data;
  if (!Array.isArray(fieldData)) {
    return { ok: false, motivo: "resposta_ilegivel", detalhe: "sem_field_data" };
  }

  const respostas = respostasDoFieldData(fieldData);
  if (respostas.length === 0) {
    return { ok: false, motivo: "sem_respostas", detalhe: `field_data_itens=${fieldData.length}` };
  }
  return { ok: true, respostas };
}
