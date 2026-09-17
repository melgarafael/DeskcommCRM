/**
 * As regras do termo que a pessoa digita na busca do Inbox.
 *
 * Este módulo é a ÚNICA régua: o schema Zod (`listConversationsQuerySchema`) e a
 * tela (`components/inbox/InboxLayout.tsx`) leem daqui. Repetir a regra de um dos
 * lados faz os dois divergirem no primeiro ajuste — e, como a rota recusa e o
 * `useConversationsRealtime` trata falha com `showApiError`, a divergência não
 * aparece como bug silencioso: aparece como erro na cara de quem está digitando.
 */

/**
 * Quantos caracteres o termo precisa ter, DEPOIS de normalizado, para ir ao banco.
 *
 * Medido em produção: `?search=a` devolvia a lista INTEIRA — e lista inteira sob
 * busca não é resposta, é ruído que PARECE resposta. O handler já aplicava este
 * raciocínio ao telefone (piso de 4 dígitos, com a justificativa escrita lá);
 * faltava aplicá-lo ao texto.
 */
export const PISO_DA_BUSCA = 2;

/**
 * Colapsa os separadores do termo digitado num curinga do PostgREST.
 *
 * ─── O defeito que ela conserta ──────────────────────────────────────────────
 * Medido na tela, com o contato "Paulo Lima Jr" no banco:
 *
 *     "Paulo  Lima"  (espaço duplo)            → 0
 *     "Paulo Jr"     (palavras não adjacentes) → 0
 *     "Paulo, Jr"    (as MESMAS, com vírgula)  → 1
 *
 * A terceira acha porque a vírgula é trocada por `*` no saneamento, e o PostgREST
 * converte `*` em `%`. Ou seja: pontuar o nome faz a busca funcionar MELHOR — um
 * recurso real, poderoso e invisível, que ninguém descobre sozinho.
 *
 * Esta função torna o acidente uma regra: todo separador vira o mesmo curinga.
 *
 * ⚠️ NÃO substitui `termoSeguroParaOr` (`app/api/v1/conversations/_handler.ts`).
 * Aquela cuida da GRAMÁTICA do `or=` do PostgREST e está correta — mexer nela é
 * regressão, e isso foi medido contra a instância real. Esta cuida de COMO A
 * PESSOA DIGITA. As duas compõem, nesta ordem, e `termoSeguroParaOr` não escapa
 * `*`, então o curinga posto aqui chega inteiro ao banco.
 */
export function normalizarTermoDeBusca(bruto: string): string {
  return bruto
    .trim()
    .split(/[\s,;]+/)
    .filter(Boolean)
    .join("*");
}

/**
 * O termo digitado vale uma consulta ao banco?
 *
 * ⛔ Mede o termo DEPOIS de normalizado, e é por isso que ela existe em vez de um
 * `length >= PISO_DA_BUSCA` solto: colapsar separadores faz um termo feito só de
 * pontuação (`", ,"`) virar string VAZIA — e string vazia no `ilike` vira `%%`,
 * que casa TUDO. Seria a lista inteira de volta, que é exatamente o defeito que o
 * piso veio consertar, reintroduzido por outra porta.
 *
 * O piso em caracteres crus não pega esse caso: `", ,"` tem 3 caracteres.
 */
export function buscaValeConsulta(bruto: string): boolean {
  return normalizarTermoDeBusca(bruto).length >= PISO_DA_BUSCA;
}
