/**
 * QUAL VERSÃO O EDITOR DO AGENTE ABRE — e por que a resposta óbvia estava errada.
 *
 * ─── O defeito, relatado da produção ────────────────────────────────────────
 *
 * "Abri o agente e o prompt sumiu." A tela mostrava
 * "Você é um atendente. Responda de forma educada e clara, em pt-BR." — 21
 * tokens — enquanto a versão PUBLICADA, com 16.714 caracteres, atendia no
 * WhatsApp normalmente. E o botão oferecia "Publicar v6": um clique e o texto
 * vazio substituiria o bom.
 *
 * Duas decisões encadeadas produziam isso:
 *
 *   1. `draft ?? published` — o rascunho vencia SEMPRE, inclusive quando era
 *      mais ANTIGO que a versão publicada. Um rascunho de terça não descreve o
 *      agente que foi publicado na quarta; ele é lixo que sobrou.
 *   2. Sem rascunho e sem publicada — o estado de todo agente PAUSADO, porque
 *      pausar despublica e a versão vira `superseded` — o formulário caía no
 *      texto padrão. Abrir a tela de um agente pausado já mostrava o prompt
 *      "sumido", e salvar dali gravava o texto padrão num rascunho novo. É a
 *      forma como o trabalho se perdia sozinho, sem ninguém apagar nada.
 *
 * ─── A regra ────────────────────────────────────────────────────────────────
 *
 * O editor abre o rascunho VIGENTE; na falta dele, a versão publicada; na falta
 * das duas, a última versão que existiu. O agente só cai no texto padrão quando
 * de fato nunca teve versão nenhuma — que é o único caso em que "padrão" é a
 * verdade.
 *
 * "Vigente" é o ponto: um rascunho anterior à publicada foi superado por ela.
 * Ele não abre no editor e não aparece no botão de publicar — oferecer publicar
 * um texto que a tela não está mostrando é a versão pior do mesmo defeito.
 *
 * ─── O nome diz "tela", mas quem GRAVA também pergunta aqui ─────────────────
 *
 * `saveAgentDraftAction` decide por esta mesma função em qual rascunho a escrita
 * cai. Enquanto ele tinha régua própria ("o rascunho de maior número"), as duas
 * discordavam exatamente no rascunho superado: a tela abria a publicada e a
 * escrita ia para o rascunho velho — que a tela não reabre, o botão não publica,
 * e cujo conteúdo, prometido no Histórico, era sobrescrito em silêncio.
 *
 * Por isso a régua é UMA, e `tests/unit/rascunho-superado-nao-e-regravado.test.ts`
 * cobra que todo chamador de produção passe o ponteiro — o argumento opcional
 * abaixo existe para o histórico da migração, não para ser omitido.
 */

/** O mínimo que a decisão precisa de uma versão. */
export interface VersaoParaEscolha {
  id: string;
  version_number: number;
  status: string;
}

export interface VersoesDaTela<T extends VersaoParaEscolha> {
  /** Rascunho VIGENTE (mais novo que a publicada). `null` quando não há. */
  draft: T | null;
  /** A versão publicada — a que responde no WhatsApp. */
  published: T | null;
  /**
   * De onde o formulário se hidrata. Cai para a última versão existente quando
   * não há rascunho nem publicada, para o prompt não "sumir" num agente pausado.
   */
  base: T | null;
  /**
   * Havia um rascunho, mas ele é anterior à publicada — a tela deve dizer isso
   * em vez de escondê-lo, senão o autor não entende por que o botão sumiu.
   */
  draftObsoleto: T | null;
}

function maisNova<T extends VersaoParaEscolha>(versoes: readonly T[]): T | null {
  return versoes.reduce<T | null>(
    (a, b) => (a !== null && a.version_number > b.version_number ? a : b),
    null,
  );
}

export function escolherVersoesDaTela<T extends VersaoParaEscolha>(
  versoes: readonly T[],
  /**
   * `ai_agents.published_version_id` — o ponteiro, que é a fonte da verdade do
   * RUNTIME (`agent-config.ts` faz `join … on v.id = a.published_version_id`).
   *
   * Sem ele, a escolha caía em `status === "published"`, e os dois divergem: há
   * agente em produção com uma versão marcada `published` e o ponteiro NULO. A
   * tela dizia "Publicado v1" para um agente que o runtime não atende — e o
   * badge de status ao lado, que já lia o ponteiro, dizia "Rascunho". Duas
   * respostas contraditórias na mesma tela, e a errada era a otimista.
   *
   * Opcional para o chamador que ainda não o passa; nesse caso vale o
   * comportamento antigo, que é melhor que não ter versão nenhuma.
   */
  publishedVersionId?: string | null,
): VersoesDaTela<T> {
  const published =
    publishedVersionId !== undefined
      ? (versoes.find((v) => v.id === publishedVersionId) ?? null)
      : (versoes.find((v) => v.status === "published") ?? null);
  const rascunho = maisNova(versoes.filter((v) => v.status === "draft"));

  // Rascunho anterior à publicada foi superado por ela: não abre, não publica.
  const obsoleto =
    rascunho !== null && published !== null && rascunho.version_number < published.version_number;

  const draft = obsoleto ? null : rascunho;
  const base = draft ?? published ?? maisNova(versoes);

  return { draft, published, base, draftObsoleto: obsoleto ? rascunho : null };
}
