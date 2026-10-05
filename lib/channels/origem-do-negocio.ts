import type { OrigemDoNascimento } from "@/lib/leads/nascimento-do-lead";

import { SOCIAL_NETWORKS } from "./social/catalog";

/**
 * DE ONDE O NEGÓCIO VEIO, dito pelo canal da conversa que o fez nascer.
 *
 * ## O defeito que este arquivo fecha
 *
 * `garantirLeadDaConversa` aceita a origem como parâmetro e, sem ela, assume
 * WhatsApp — o único canal que existia quando ele foi escrito. A ingestão
 * compartilhada (`pos-entrada.ts`) nunca passava a origem, então um negócio
 * que nasceu de uma mensagem no direct do Instagram ficava com:
 *
 *   - `crm_leads.source = 'whatsapp'` — e todo relatório por canal o contava
 *     no lugar errado;
 *   - na linha do tempo, "primeira mensagem recebida no WhatsApp";
 *   - no card sem nome, "Novo contato pelo WhatsApp".
 *
 * Medido numa VPS em 2026-10-03: conversa `channel = 'instagram'`, negócio com
 * `source = 'whatsapp'`.
 *
 * ## Por que DERIVAR do catálogo
 *
 * O nome da rede sai de `SOCIAL_NETWORKS`, o mesmo catálogo que decide quais
 * redes têm atendimento (`inbox`) e de onde `CANAIS_DE_CONVERSA` é derivado.
 * Uma rede nova com `inbox: true` ganha a origem certa sem tocar aqui.
 *
 * ## Por que o padrão é WhatsApp
 *
 * É o canal das conversas que não vêm do intermediário social (QR e oficial), e
 * é o MESMO objeto que `garantirLeadDaConversa` usa quando ninguém passa
 * origem (`ORIGEM_PADRAO` aponta para `ORIGEM_DO_WHATSAPP`): um texto só.
 * Um canal que o catálogo não reconhece cai no padrão em vez de gravar um
 * `source` inventado.
 */
export const ORIGEM_DO_WHATSAPP: OrigemDoNascimento = {
  rotulo: "WhatsApp",
  source: "whatsapp",
  motivo: "primeira mensagem recebida no WhatsApp",
};

export function origemDoNegocioPeloCanal(canal: string | null | undefined): OrigemDoNascimento {
  const rede = SOCIAL_NETWORKS.find((r) => r.inbox && r.id === canal);
  if (!rede) return ORIGEM_DO_WHATSAPP;
  return {
    rotulo: rede.label,
    source: rede.id,
    motivo: `primeira mensagem recebida no ${rede.label}`,
  };
}
