/**
 * OS GRUPOS DE RESPOSTAS RÁPIDAS (#3245) — a régua que a tela e o Inbox
 * compartilham.
 *
 * ─── O contrato do "opcional", e por que ele mora numa função pura ──────────
 *
 * Grupo é recurso OPCIONAL: quem nunca criou um continua com a lista plana de
 * hoje, byte a byte. Isso não pode ser um detalhe espalhado por dois JSX — é a
 * MESMA decisão em dois lugares (a tela de Respostas rápidas e a barra do
 * Inbox), e uma decisão copiada é uma decisão que diverge. `secoesDeRespostas`
 * devolve `null` quando NÃO há grupo nenhum, e `null` é a instrução "desenhe a
 * lista plana de sempre": quem chama não decide por conta própria, não
 * reorganiza nada e não acrescenta cabeçalho nenhum.
 *
 * ─── A ordem ───────────────────────────────────────────────────────────────
 *
 * As seções saem na ordem dos grupos (`ordem`, desempate pelo nome) e, no FIM,
 * a seção `grupo: null` com as respostas sem grupo — ela só existe se houver
 * alguma. A ordem DAS RESPOSTAS dentro da seção é a que veio do servidor
 * (`ordem` da 0729): agrupar não reordena, e é o arrastar e soltar da tela que
 * grava a posição.
 *
 * Grupo sem resposta nenhuma aparece na lista devolvida: é o que a TELA precisa
 * para mostrar o grupo recém-criado, vazio, pronto para receber resposta. Quem
 * não quer grupo vazio na tela (a barra do Inbox) filtra por
 * `respostas.length > 0` — filtrar aqui esconderia o grupo da tela que o criou.
 *
 * ─── Grupo que a lista não conhece ─────────────────────────────────────────
 *
 * A resposta pode apontar para um `grupo_id` que não está na lista de grupos
 * (outra aba acabou de apagar o grupo e o cache está velho; o `on delete set
 * null` do banco ainda não chegou pela invalidação). Essa resposta entra na
 * seção "sem grupo" em vez de sumir: perder a resposta da tela por causa de um
 * vínculo velho é pior do que mostrá-la no lugar onde ela sempre esteve.
 */

/** O grupo como a tela o lê — o subconjunto que `GET /message-template-groups` devolve. */
export interface GrupoDeRespostas {
  id: string;
  name: string;
  /** Posição na exibição (`ordem` da 0808). Ausente em fixture antiga = 0. */
  ordem?: number;
}

/** O mínimo da resposta rápida que o agrupamento precisa conhecer. */
export interface RespostaAgrupavel {
  id: string;
  /** `null`/ausente = sem grupo. Linha anterior à 0808 chega assim. */
  grupo_id?: string | null;
}

/** Uma seção da tela: o grupo (ou `null` para "sem grupo") e as respostas dele. */
export interface SecaoDeRespostas<T> {
  grupo: GrupoDeRespostas | null;
  respostas: T[];
}

/**
 * A lista em SEÇÕES, ou `null` quando não há grupo nenhum — e `null` significa
 * "desenhe a lista plana de hoje".
 */
export function secoesDeRespostas<T extends RespostaAgrupavel>(
  respostas: readonly T[],
  grupos: readonly GrupoDeRespostas[] | null | undefined,
): SecaoDeRespostas<T>[] | null {
  // Sem grupo cadastrado não há o que agrupar. É o caminho de quem nunca usou o
  // recurso, e ele não pode produzir um DOM diferente do de antes.
  if (!grupos || grupos.length === 0) return null;

  const ordenados = [...grupos].sort(
    (a, b) => (a.ordem ?? 0) - (b.ordem ?? 0) || a.name.localeCompare(b.name),
  );
  const porGrupo = new Map<string, T[]>();
  const semGrupo: T[] = [];
  const conhecidos = new Set(ordenados.map((grupo) => grupo.id));

  for (const resposta of respostas) {
    const chave = resposta.grupo_id ?? null;
    if (chave !== null && conhecidos.has(chave)) {
      const atual = porGrupo.get(chave);
      if (atual) atual.push(resposta);
      else porGrupo.set(chave, [resposta]);
    } else {
      // Sem grupo, ou apontando para um grupo que a lista não conhece.
      semGrupo.push(resposta);
    }
  }

  const secoes: SecaoDeRespostas<T>[] = ordenados.map((grupo) => ({
    grupo,
    respostas: porGrupo.get(grupo.id) ?? [],
  }));
  // A seção "sem grupo" fica no fim e só existe quando tem resposta: um
  // cabeçalho "Sem grupo" vazio não diz nada a ninguém.
  if (semGrupo.length > 0) secoes.push({ grupo: null, respostas: semGrupo });
  return secoes;
}

/**
 * O grupo de UMA resposta, para o slash-menu do Inbox mostrar o nome ao lado do
 * título (#3245) — quem procura "prazo" acha a resposta mesmo sem lembrar do
 * grupo, e vê a que etapa ela pertence antes de escolher.
 *
 * `null` quando a resposta não tem grupo, ou quando aponta para um que a lista
 * não conhece: nos dois casos a frase certa é "sem grupo".
 */
export function grupoDaResposta(
  resposta: RespostaAgrupavel,
  grupos: readonly GrupoDeRespostas[] | null | undefined,
): GrupoDeRespostas | null {
  if (!resposta.grupo_id || !grupos?.length) return null;
  return grupos.find((grupo) => grupo.id === resposta.grupo_id) ?? null;
}
