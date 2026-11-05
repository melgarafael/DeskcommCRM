/**
 * O MODO "IA COM O DONO" — a IA responde uma conversa que já tem atendente,
 * sem soltar o dono (#3967, fatia 1).
 *
 * ─── O que existe hoje, e o que dói ────────────────────────────────────────
 *
 * `conversations.assignee_kind = 'user'` é VETO ABSOLUTO no gate de
 * elegibilidade (`lib/ai/elegibilidade/gate.ts` → `conversa_de_humano`). Não é
 * bug: desde a 0032, dono humano significa "o automático saiu desta conversa".
 * O problema é que o único caminho de volta é `devolverAtendimentoAoAgente`
 * (`lib/escalacao/retomada.ts`), que faz `release` do dono: a conversa sai da
 * fila do atendente, sai da carteira dele e, numa org com rodízio, volta para a
 * distribuição — quem estava acompanhando o cliente perde o acompanhamento
 * justamente quando quer usar a IA como apoio.
 *
 * ─── O estado é EXPLÍCITO, por conversa, e mora em `conversations.metadata` ─
 *
 * `ai_com_dono: true` dentro do jsonb que a linha já tem. As razões:
 *
 *   1. NÃO é `assignee_kind = 'ai'`. O CHECK `conversations_assignee_kind_
 *      coherence` (baseline, migration 0032) proíbe `'ai'` com dono preenchido,
 *      e afrouxá-lo mudaria o significado de "quem manda" em toda a base — o
 *      mesmo motivo pelo qual a issue foi recortada em fatias.
 *   2. NÃO é coluna nova. `conversations.metadata` já é o lar de marcas por
 *      conversa lidas defensivamente (`handoff_tecnico`, `devolucao_ao_rodizio`)
 *      e já viaja no payload do Inbox (`SELECT_COLS` da rota, `Conversation` em
 *      `lib/types/messaging.ts`) — o controle aparece sem inventar leitura nova
 *      e sem migration, com o CHECK intacto.
 *   3. NÃO é `bot_silenced_until`. Silêncio é a trava de "o automático está
 *      pausado"; usá-lo para dizer "pode responder" inverteria o sentido da
 *      coluna que três guards leem (`isLeadInHandoff`, worker, `before-send`).
 *
 * ─── Uma régua, dois consumidores ──────────────────────────────────────────
 *
 * `donoHumanoVetaIA` é a MESMA função no gate puro (que o drain, o turno, o
 * worker legado e o handoff consultam via os dois transportes) e no worker
 * pré-engine, que tem a sua própria guarda local. Duas cópias da regra
 * divergiriam na primeira vez que alguém acrescentasse um caso — e o caso aqui é
 * sutil: o modo só vale quando EXISTE dono humano, e nunca fura as outras
 * travas (contato travado, opt-out, silêncio, contato interno, organização,
 * canal).
 *
 * A leitura trata lixo como ausência: `metadata` é jsonb escrito por vários
 * módulos, e o custo de errar para "não havia modo" é a conversa ficar calada —
 * recuperável num clique —, enquanto o de errar para "havia" é a IA falar por
 * cima de uma pessoa sem ninguém ter pedido.
 */

/** Chave dentro de `conversations.metadata`. */
export const CHAVE_DA_IA_COM_DONO = "ai_com_dono";

/**
 * O modo está ligado? Só o booleano `true` liga — `"true"`, `1`, `"sim"` e
 * qualquer outra coisa são ausência, pela mesma régua de `force_human`.
 */
export function lerModoIaComDono(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  return (metadata as Record<string, unknown>)[CHAVE_DA_IA_COM_DONO] === true;
}

/**
 * O metadata NOVO, com o modo ligado ou desligado. Preserva todo o resto do
 * jsonb: `handoff_tecnico`, `devolucao_ao_rodizio` e o que mais mora ali não
 * podem ser apagados por um interruptor.
 *
 * Desligar REMOVE a chave em vez de gravá-la como `false`: o estado de quem
 * nunca ligou o modo volta a ser byte a byte o de hoje, e um `false` explícito
 * faria a linha parecer "configurada para não" quando ninguém configurou nada.
 */
export function metadataComModoIaComDono(
  metadata: unknown,
  ligado: boolean,
): Record<string, unknown> {
  const base =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? { ...(metadata as Record<string, unknown>) }
      : {};
  if (ligado) return { ...base, [CHAVE_DA_IA_COM_DONO]: true };
  delete base[CHAVE_DA_IA_COM_DONO];
  return base;
}

/**
 * O modo está ligado E existe um dono para proteger.
 *
 * É esta a condição que os caminhos destrutivos consultam (devolução ao agente,
 * devolução ao rodízio, `pending` de fila no handoff): com o modo ligado mas SEM
 * dono, não há nada a preservar — a conversa é uma conversa normal, e segurá-la
 * aqui só a prenderia para fora do rodízio.
 */
export function modoProtegeODono(e: {
  metadata: unknown;
  assignedToUserId: string | null;
}): boolean {
  return lerModoIaComDono(e.metadata) && (e.assignedToUserId ?? null) !== null;
}

/**
 * A REGRA: o dono humano veta a IA?
 *
 * `true` (veta) em tudo que é hoje, exceto quando o modo está ligado NESTA
 * conversa E existe de fato um dono humano. Ligar o modo numa conversa sem dono
 * não autoriza nada — ali não há veto de dono para desligar, e o resto da régua
 * do canal continua decidindo sozinho.
 */
export function donoHumanoVetaIA(e: { assigneeKind: string | null; iaComDono: boolean }): boolean {
  return e.assigneeKind === "user" && !e.iaComDono;
}
