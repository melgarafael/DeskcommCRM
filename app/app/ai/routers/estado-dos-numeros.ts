/**
 * #4340 — a leitura da lista de roteadores precisa contar a verdade sobre o
 * NÚMERO, não só sobre a linha de `ai_routers`.
 *
 * ─── O defeito medido ────────────────────────────────────────────────────────
 *
 * Quando o agente de IA troca de número de WhatsApp, o roteador continua
 * apontando para o `channel_session_id` antigo. A tela já sabia mostrar
 * "Número removido" (o canal não está na lista de canais oferecíveis, porque
 * `listSelectableChannels` filtra `archived_at is null`), mas o selo continuava
 * "ativo": o operador via um roteador verde apontando para um número que não
 * existe mais, e o número NOVO — o que recebe as conversas — não aparecia em
 * lugar nenhum da tela. Quem olhasse a lista concluía que estava tudo roteado.
 *
 * ─── A regra, e por que ela mora aqui ────────────────────────────────────────
 *
 * 1. Roteador cujo número sumiu da lista oferecível (arquivado/removido) NÃO é
 *    um roteador ativo: nada chega nele. A leitura o devolve como inativo.
 *    `is_active` é config gravada; esta função é o estado EFETIVO — e a tela
 *    mostra o efetivo.
 * 2. Número oferecível SEM nenhum roteador apontando para ele é o outro lado do
 *    mesmo defeito: as conversas dele caem no agente principal do número, e o
 *    turno desse caminho não grava decisão de roteamento. A lista precisa
 *    mostrar esse número com o aviso, senão ele segue invisível.
 *
 * É função pura (sem Supabase, sem React) porque é a REGRA que precisa de
 * cerca: o teste de página (`page.test.tsx`) prova que a leitura a usa, e o
 * teste desta função prova os casos de borda sem montar DOM.
 */
import type { SelectableChannel } from "@/lib/channels/selectable";
import type { RouterListItem } from "@/hooks/ai/useRouters";

/** Um número que recebe conversas e não tem roteador nenhum apontando para ele. */
export interface NumeroSemRoteador {
  id: string;
  /** `display_name · phone_number`, o mesmo rótulo das outras telas. */
  rotulo: string;
}

export interface EstadoDosRoteadores {
  /** Os roteadores com o `is_active` EFETIVO (número removido ⇒ inativo). */
  itens: RouterListItem[];
  numerosSemRoteador: NumeroSemRoteador[];
  /** Ids dos roteadores cujo número não existe mais entre os oferecíveis. */
  numerosRemovidos: string[];
}

/** O rótulo de um número — um lugar só, para a tela não inventar formato. */
export function rotuloDoNumero(canal: SelectableChannel): string {
  return canal.phone_number ? `${canal.display_name} · ${canal.phone_number}` : canal.display_name;
}

/** O canal do roteador, ou `undefined` quando ele foi arquivado/removido. */
export function canalDoRoteador(
  canais: SelectableChannel[],
  channelSessionId: string,
): SelectableChannel | undefined {
  return canais.find((c) => c.id === channelSessionId);
}

export function lerEstadoDosRoteadores(
  roteadores: RouterListItem[],
  canais: SelectableChannel[],
): EstadoDosRoteadores {
  const numerosRemovidos: string[] = [];
  const itens = roteadores.map((r) => {
    if (canalDoRoteador(canais, r.channel_session_id) !== undefined) return r;
    numerosRemovidos.push(r.id);
    // Um roteador já inativo continua inativo; um ativo apontando para número
    // que não existe deixa de estar ativo. `is_active` é config, o estado
    // efetivo é este.
    return r.is_active ? { ...r, is_active: false } : r;
  });

  const comRoteador = new Set(roteadores.map((r) => r.channel_session_id));
  const numerosSemRoteador = canais
    .filter((c) => !comRoteador.has(c.id))
    .map((c) => ({ id: c.id, rotulo: rotuloDoNumero(c) }));

  return { itens, numerosSemRoteador, numerosRemovidos };
}
