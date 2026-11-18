/**
 * O estado de um material da base de conhecimento que o agente CONSULTA.
 *
 * Existe porque "tirar do arquivo" tem dois vocabulários e trocá-los já custou
 * caro nesta fatia:
 *
 *  * o pedido da API diz `status: "active"` — "está no acervo", na língua de
 *    quem chama (`PATCH /api/v1/ai/knowledge/sources/[id]`);
 *  * a COLUNA `ai_knowledge_sources.status` só aceita `ready | archived |
 *    building | failed` (`ai_knowledge_sources_status_check`), e o motor de
 *    busca — `fn_buscar_trechos_das_fontes` (0181) — só enxerga a fonte com
 *    `s.is_active and s.status = 'ready'`.
 *
 * Gravar `active` na coluna viola o CHECK (23514) e, mesmo que o CHECK
 * aceitasse, deixaria o material na tela e invisível para o agente. Por isso o
 * valor mora aqui, num lugar só: a rota, os testes da rota e o invariante de
 * banco que roda a função de busca de verdade medem o MESMO par.
 */
export const STATUS_DO_MATERIAL_CONSULTAVEL = "ready" as const;

/**
 * O update EXATO do desarquivar — o inverso do soft-delete do DELETE.
 *
 * Os dois campos andam juntos: o rag-indexer pula a fonte com
 * `!is_active || status === 'archived'` (`workers/rag-indexer.ts`), e a busca
 * exige `is_active and status='ready'`. Devolver só um dos dois deixa o
 * material na lista e fora da resposta do agente — pior que o arquivo, porque
 * some sem aviso.
 */
export const PATCH_DE_RESTAURO = {
  status: STATUS_DO_MATERIAL_CONSULTAVEL,
  is_active: true,
} as const;
