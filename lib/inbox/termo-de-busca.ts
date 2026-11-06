/**
 * As regras do termo que a pessoa digita na busca — do Inbox e dos contatos.
 *
 * Este módulo é a ÚNICA régua: o schema Zod (`listConversationsQuerySchema`) e a
 * tela (`components/inbox/InboxLayout.tsx`) leem daqui. Repetir a regra de um dos
 * lados faz os dois divergirem no primeiro ajuste — e, como a rota recusa e o
 * `useConversationsRealtime` trata falha com `showApiError`, a divergência não
 * aparece como bug silencioso: aparece como erro na cara de quem está digitando.
 *
 * Desde a #1835 a listagem de CONTATOS lê as MESMAS duas funções
 * (`app/api/v1/contacts/_handler.ts`). Ali a régua é aplicada DENTRO do handler,
 * e não no schema: a tela de contatos manda o termo do jeito que foi digitado
 * (`useContactList` não tem guarda de piso) e um `422` acenderia `showApiError`
 * a cada letra digitada — enquanto o MCP (`crm_search_contacts`) chamaria o
 * handler direto e receberia um `ZodError` no meio da ferramenta. O efeito que a
 * issue pede é o mesmo dos dois lados: abaixo do piso a busca NÃO VAI AO BANCO.
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
 *
 * O PARÊNTESE entra aqui pelos MESMOS dois motivos:
 *
 * - `normalizarTermoDeBusca` colapsa `\s,;` — parêntese não é separador, então
 *   `"()"` vira 2 caracteres e passa um piso qualquer.
 * - `termoSeguroParaOr` (o `or=` da inbox) troca `()` por `*`: `"()"` vira `**`,
 *   o PostgREST vira `%%%%`, e a busca devolve a LISTA INTEIRA — o defeito que a
 *   #1892 consertou no handler de contatos e que este módulo torna régua única,
 *   valendo também para o schema (`lib/schemas/messaging.ts`) e a tela
 *   (`components/inbox/InboxLayout.tsx`), que leem daqui.
 *
 * O `replace` NO PISO não muda o termo que vai ao banco — ele só decide se vale
 * consultar. O parêntese que sobra (ex. um telefone `(15) 99259-4261`) continua
 * vindo atrás dele e segue funcionando, como os controles abaixo provam.
 *
 * O ASTERISCO entra aqui pela mesma porta do parêntese (#1935): a pessoa pode
 * digitar `*` (por exemplo `s*` pensando em curinga de nome). `normalizarTermoDeBusca`
 * não colapsa `*` (não é separador), então `"**"` passa o piso; e `termoSeguroParaOr`
 * NÃO escapa `*` — no `or=` do PostgREST, `*` vira `%`, e `**` vira `%%`: a lista
 * inteira de volta, o mesmo defeito que o piso veio consertar. Tirá-lo do piso é
 * seguro porque um `*` SEM homem no termo não significa nada para a busca — ele
 * só ia ao banco para virar curinga e casar tudo.
 */
export function buscaValeConsulta(bruto: string): boolean {
  const semLixo = bruto.replace(/[()*]/g, " ");
  return normalizarTermoDeBusca(semLixo).length >= PISO_DA_BUSCA;
}

/**
 * Letras que o NFD não decompõe — o `unaccent` do Postgres mapeia todas elas.
 *
 * Sem esta tabela, um contato cadastrado como "Øyvind" (coluna do banco:
 * "oyvind") deixaria de ser achado por quem digita "Øyvind" — um REGRESSO em
 * relação ao `ilike` atual, que casava igual com igual. A lista é a das letras
 * latinas que o arquivo `unaccent.rules` cobre e a decomposição NFD não.
 */
const NAO_DECOMPOEM: Record<string, string> = {
  ß: "ss",
  æ: "ae",
  œ: "oe",
  ø: "o",
  đ: "d",
  ð: "d",
  ł: "l",
  þ: "th",
  ı: "i",
  ħ: "h",
  ŧ: "t",
  ĸ: "k",
};

/**
 * O termo como o BANCO o guarda: sem acento e em minúscula (#3918).
 *
 * ─── Por que existe, se o `ilike` já dobra a caixa ───────────────────────────
 * `ILIKE` dobra CAIXA, não ACENTO: `lower('Á') = 'á'`, que não é `'a'`. Quem
 * digita "Andreia" não acha "Andréia" — e no Brasil a mesma pessoa é escrita das
 * duas formas, com o atendente digitando rápido, sem acento.
 *
 * ─── O outro lado mora no banco, e não aqui ──────────────────────────────────
 * A coluna `contacts.busca_sem_acento` é GERADA por
 * `lower(public.f_unaccent(…))` (migration 9098). Comparar o termo limpo contra
 * a coluna crua não resolveria nada — os dois lados têm de estar normalizados,
 * e é por isso que a coluna existe: `ilike` sobre `display_name` continua sem
 * achar nada, por mais limpo que o termo chegue.
 *
 * ⚠️ Esta função e `public.f_unaccent` são a MESMA regra em duas linguagens, e
 * duas cópias divergem no primeiro ajuste (é a classe de defeito que já apareceu
 * neste repo com telefone). O que as mantém juntas é
 * `tests/invariants/busca-do-inbox-ignora-acento.test.ts`, que compara as duas
 * sobre uma matriz de nomes — não uma delas sozinha.
 */
export function termoSemAcento(bruto: string): string {
  return bruto
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[ßæœøđðłþıħŧĸ]/gi, (letra) => NAO_DECOMPOEM[letra.toLowerCase()] ?? letra)
    .toLowerCase();
}
