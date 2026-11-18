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
 *
 * ─── Escopo `so_crm` ────────────────────────────────────────────────────────
 *
 * Com `so_crm` a prévia conta só o que a rodada importaria: cada chat precisa
 * casar uma ficha viva (`fichaDoCrmParaOChat`), com os mesmos telefones que a
 * rodada usa. Resolver o @lid e ler a 1ª página de mensagens (onde estão os
 * `remoteJidAlt`) gastam do MESMO teto. Se a lista de conversas for cortada
 * pelo teto antes de se conferir fichas, a prévia sai com `conversas: 0` e
 * `parcial: true`: nenhum chat foi confirmado.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { lerGuardarHistorico } from "@/lib/channels/acervo-do-historico";
import {
  fichaDoCrmParaOChat,
  telefonesDoChatParaFicha,
  type EscopoDaImportacao,
} from "@/lib/channels/historico/fichas-do-crm";
import { getWahaClient } from "@/lib/waha/client";
import { ehReacao, parseChatId, resolveMessageType, type WahaPayload } from "@/lib/waha/ingest";

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
  /** Só o escopo `so_crm` usa: o telefone que o canal conhece para um @lid. */
  resolvePhoneForLid?(session: string, lid: string): Promise<string | null>;
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

/**
 * @param admin cliente administrador: só o escopo `so_crm` o usa (a ficha).
 * @param organizationId organização da importação; vem da conexão, nunca do corpo do pedido.
 * @param escopo `todos` (como sempre) ou `so_crm` (só chats com ficha viva).
 */
export async function calcularPrevia(
  admin: SupabaseClient,
  organizationId: string,
  escopo: EscopoDaImportacao,
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

  // Conta as mensagens de um chat a partir de `primeira` (já lida) ou da página 0.
  // `false` = o teto acabou no meio.
  const contarMensagens = async (
    chatId: string,
    primeira?: { mensagens: WahaPayload[]; lidas: number },
  ): Promise<boolean> => {
    let pagina = primeira;
    for (let offset = 0; ; ) {
      if (!pagina) {
        if (!cabe()) return false;
        chamadas += 1;
        pagina = await canal.paginaDeMensagens(nomeNoCanal, chatId, {
          limit: PAGINA_DE_MENSAGENS,
          offset,
          desde,
        });
      }
      if (pagina.lidas === 0) return true;
      for (const p of pagina.mensagens) {
        if (!p.id || ehReacao(p)) continue;
        r.mensagens += 1;
        const tipo = resolveMessageType(p);
        if (tipo === "audio") r.audios += 1;
        else if (tipo === "image") r.imagens += 1;
      }
      offset += pagina.lidas;
      pagina = undefined;
    }
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
  // No `so_crm` a conta vem só depois de conferir cada ficha (abaixo).
  if (escopo === "todos") r.conversas = naJanela.length;
  if (r.parcial) return r;

  // 2a. Escopo `todos`: mensagens de cada chat da janela, com o que sobrou do teto.
  if (escopo === "todos") {
    for (const chatId of naJanela) {
      if (!(await contarMensagens(chatId))) return r;
    }
    return r;
  }

  // 2b. Escopo `so_crm`: só conta o chat que casa uma ficha viva.
  for (const chatId of naJanela) {
    if (!cabe()) return r;
    const lid = parseChatId(chatId).lid;
    let telefoneDoLid: string | null = null;
    if (lid && canal.resolvePhoneForLid) {
      if (!cabe()) return r;
      chamadas += 1;
      telefoneDoLid = await canal.resolvePhoneForLid(nomeNoCanal, lid);
    }
    if (!cabe()) return r;
    chamadas += 1;
    const primeira = await canal.paginaDeMensagens(nomeNoCanal, chatId, {
      limit: PAGINA_DE_MENSAGENS,
      offset: 0,
      desde,
    });
    // Erro na busca da ficha LANÇA: a rota mostra o erro, em vez de um número falso.
    const ficha = await fichaDoCrmParaOChat(admin, {
      organizationId,
      telefones: telefonesDoChatParaFicha(chatId, telefoneDoLid, primeira.mensagens),
      lid,
    });
    if (!ficha) continue;
    r.conversas += 1;
    if (!(await contarMensagens(chatId, primeira))) return r;
  }
  return r;
}
