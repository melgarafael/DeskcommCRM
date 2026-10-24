/**
 * A PRÉVIA da importação do histórico do WhatsApp (#999): antes de importar,
 * quantas conversas, mensagens, áudios e imagens a janela traz.
 *
 * Mora aqui, e não na rota, porque fala com o servidor do canal: a rota não
 * nomeia o transporte (`pnpm lint:channels`).
 *
 * ─── Teto de custo ──────────────────────────────────────────────────────────
 *
 * A prévia roda dentro do pedido HTTP de quem clicou, então tem teto: no
 * máximo `TETO_DE_CHAMADAS_DA_PREVIA` chamadas ao canal. Primeiro anda a LISTA
 * de conversas inteira (barata: 50 por chamada), para o número de conversas
 * sair exato na maioria das contas; depois gasta o que sobra contando
 * mensagens. Se o teto acaba antes do fim, devolve o que contou com
 * `parcial: true`, e a tela lê "pelo menos".
 *
 * Mesmos critérios da rodada (`rodada.ts`): conversa entra se a última
 * mensagem é da janela ou se o canal não diz a data; grupo e status o cliente
 * já tira; reação e mensagem sem id não contam; a conversa só termina com
 * `lidas === 0`. Áudio e imagem pelo mesmo tipo que o mapeador marca como
 * `pendente` (`resolveMessageType`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { lerGuardarHistorico } from "@/lib/channels/acervo-do-historico";
import { getWahaClient } from "@/lib/waha/client";
import { ehReacao, resolveMessageType, type WahaPayload } from "@/lib/waha/ingest";

export interface PreviaDoHistorico {
  conversas: number;
  mensagens: number;
  audios: number;
  imagens: number;
  /** ISO do início da janela. */
  desde: string;
  /** `true` quando o teto de chamadas acabou antes do fim: os números são "pelo menos". */
  parcial: boolean;
}

/** Chamadas ao canal que uma prévia pode gastar. */
export const TETO_DE_CHAMADAS_DA_PREVIA = 100;

const PAGINA_DE_CONVERSAS = 50;
const PAGINA_DE_MENSAGENS = 100;
const SEGUNDOS_POR_DIA = 86_400;

/** O pedaço do cliente do canal que a prévia usa (dublável no teste). */
export interface CanalDaPrevia {
  paginaDeConversas(
    session: string,
    opts: { limit: number; offset: number },
  ): Promise<{ conversas: Array<{ chatId: string; ultimaEm: number | null; posicao: number }>; lidas: number }>;
  paginaDeMensagens(
    session: string,
    chatId: string,
    opts: { limit: number; offset: number; desde: number },
  ): Promise<{ mensagens: WahaPayload[]; lidas: number }>;
}

export interface SessaoDoHistorico {
  guardarHistorico: boolean;
  /** Nome da sessão no servidor do canal; `null` quando a conexão ainda não tem sessão. */
  nomeNoCanal: string | null;
}

/** A conexão, só se é da organização e não está arquivada. `null` = não achei. */
export async function lerSessaoDoHistorico(
  db: SupabaseClient,
  organizationId: string,
  canalId: string,
): Promise<SessaoDoHistorico | null> {
  const { data, error } = await db
    .from("channel_sessions")
    .select("metadata, waha_session_name")
    .eq("organization_id", organizationId)
    .eq("id", canalId)
    .is("archived_at", null)
    .maybeSingle();
  if (error) throw new Error(`sessao_leitura: ${error.message}`);
  if (!data) return null;
  const linha = data as { metadata?: unknown; waha_session_name?: string | null };
  return { guardarHistorico: lerGuardarHistorico(linha.metadata), nomeNoCanal: linha.waha_session_name ?? null };
}

export async function calcularPrevia(
  nomeNoCanal: string,
  dias: number,
  opts: { canal?: CanalDaPrevia; agora?: number; tetoDeChamadas?: number } = {},
): Promise<PreviaDoHistorico> {
  const canal = opts.canal ?? getWahaClient();
  if (!canal) throw new Error("canal_nao_configurado");
  const teto = opts.tetoDeChamadas ?? TETO_DE_CHAMADAS_DA_PREVIA;
  const desde = Math.floor((opts.agora ?? Date.now()) / 1000) - dias * SEGUNDOS_POR_DIA;
  const r: PreviaDoHistorico = {
    conversas: 0,
    mensagens: 0,
    audios: 0,
    imagens: 0,
    desde: new Date(desde * 1000).toISOString(),
    parcial: false,
  };
  let chamadas = 0;
  const cabe = () => {
    if (chamadas < teto) return true;
    r.parcial = true;
    return false;
  };

  // 1. A lista de conversas inteira (ou até o teto).
  const naJanela: string[] = [];
  for (let offset = 0; ; ) {
    if (!cabe()) break;
    chamadas += 1;
    const pagina = await canal.paginaDeConversas(nomeNoCanal, { limit: PAGINA_DE_CONVERSAS, offset });
    if (pagina.lidas === 0) break;
    for (const c of pagina.conversas) {
      if (c.ultimaEm === null || c.ultimaEm >= desde) naJanela.push(c.chatId);
    }
    offset += pagina.lidas;
  }
  // Conta ANTES de sair pelo teto: lista cortada ainda é "pelo menos N".
  r.conversas = naJanela.length;
  if (r.parcial) return r;

  // 2. Mensagens, com o que sobrou do teto.
  for (const chatId of naJanela) {
    for (let offset = 0; ; ) {
      if (!cabe()) return r;
      chamadas += 1;
      const { mensagens, lidas } = await canal.paginaDeMensagens(nomeNoCanal, chatId, {
        limit: PAGINA_DE_MENSAGENS,
        offset,
        desde,
      });
      if (lidas === 0) break;
      for (const p of mensagens) {
        if (!p.id || ehReacao(p)) continue;
        r.mensagens += 1;
        const tipo = resolveMessageType(p);
        if (tipo === "audio") r.audios += 1;
        else if (tipo === "image") r.imagens += 1;
      }
      offset += lidas;
    }
  }
  return r;
}
