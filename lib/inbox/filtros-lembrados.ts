/**
 * OS FILTROS QUE O INBOX LEMBRA — número e "Não lidos", por organização.
 *
 * Quem atende um setor só (cada setor com o seu número) abria o
 * Inbox e tinha de escolher o número e ligar "Não lidos" a cada recarga: os
 * dois eram estado local da sessão. Aqui eles passam a ficar no `localStorage`,
 * como as larguras das colunas — preferência de quem olha a tela, não dado do
 * sistema.
 *
 * Por ORGANIZAÇÃO: o id do número só existe na organização dele. Lembrado sem a
 * org, trocar de organização abriria a lista filtrada por um número que ali não
 * existe — vazia, sem motivo aparente.
 *
 * Só estes dois. Busca e etiqueta continuam valendo para a visita: a busca é
 * pergunta do momento, e a etiqueta já tem o deep-link `?tag=`.
 */

export interface FiltrosLembrados {
  channel_session_id?: string;
  onlyUnread?: boolean;
}

type Armazenamento = Pick<Storage, "getItem" | "setItem">;

export const CHAVE_DOS_FILTROS = "inbox:filtros-lembrados:v1";

function lerTudo(storage: Armazenamento): Record<string, FiltrosLembrados> {
  try {
    const cru = JSON.parse(storage.getItem(CHAVE_DOS_FILTROS) ?? "{}");
    return cru && typeof cru === "object" && !Array.isArray(cru) ? cru : {};
  } catch {
    return {};
  }
}

/** O que foi lembrado para esta organização; `{}` quando nada (ou lixo). */
export function lerFiltrosLembrados(storage: Armazenamento | null, orgId: string): FiltrosLembrados {
  if (!storage) return {};
  const f = lerTudo(storage)[orgId];
  if (!f || typeof f !== "object") return {};
  const saida: FiltrosLembrados = {};
  if (typeof f.channel_session_id === "string" && f.channel_session_id) saida.channel_session_id = f.channel_session_id;
  if (f.onlyUnread === true) saida.onlyUnread = true;
  return saida;
}

/** Grava os dois filtros desta organização sem tocar nos das outras. */
export function gravarFiltrosLembrados(
  storage: Armazenamento | null,
  orgId: string,
  filtros: FiltrosLembrados,
): void {
  if (!storage) return;
  const tudo = lerTudo(storage);
  tudo[orgId] = {
    ...(filtros.channel_session_id ? { channel_session_id: filtros.channel_session_id } : {}),
    ...(filtros.onlyUnread ? { onlyUnread: true } : {}),
  };
  try {
    storage.setItem(CHAVE_DOS_FILTROS, JSON.stringify(tudo));
  } catch {
    // Quota cheia ou armazenamento bloqueado: o filtro só não fica lembrado.
  }
}
