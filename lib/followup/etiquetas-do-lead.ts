/**
 * AS ETIQUETAS DE UM LEAD PARA AS CONDIÇÕES DO FLUXO — as DUAS caixas, numa lista só.
 *
 * ─── O defeito que este arquivo fecha (#4586) ──────────────────────────────
 *
 * O produto grava marcador em dois lugares que NÃO são o mesmo:
 *
 * - `crm_leads.tags` — do NEGÓCIO, escrito em «Editar negócio»;
 * - `contacts.tags`  — da PESSOA, escrito no Inbox e na ficha — e é a caixa que
 *   a campanha de prospecção usa (`marcarEtiquetasDaCampanha` com
 *   `config.contact_tags`, vinda do «Público ou segmento»).
 *
 * A condição «Etiqueta do contato» do follow-up lia só a PRIMEIRA. Numa
 * campanha por nicho o contato nascia com «dentista» e o card ficava sem
 * etiqueta nenhuma: a condição respondia «não tem» e o fluxo caía sempre no
 * ramo padrão, com a tela prometendo o contrário («O contato tem a etiqueta…»).
 *
 * ─── O que já foi consertado antes, e o que sobra para cá ───────────────────
 *
 * O #4606 (na `main` desde 14/11) passou a COPIAR as etiquetas da campanha para
 * o card no momento em que ele nasce — e o próprio fragmento de release diz o
 * limite: «vale para os cards criados a partir da atualização; os que já
 * existem não mudam». Sobram dois buracos reais, e é deles que este arquivo
 * trata:
 *
 * 1. card criado ANTES da atualização, numa instalação com campanha rodando —
 *    ele nunca vai ganhar a etiqueta sem backfill, e backfill de etiqueta é
 *    decisão de quem opera, não efeito colateral de deploy;
 * 2. etiqueta posta no CONTATO por fora da campanha (Inbox, ficha, importação
 *    por CSV) — ela nunca chega ao card, e a tela continua dizendo «contato».
 *
 * Nos dois casos a etiqueta JÁ ESTÁ GRAVADA em `contacts.tags`: basta a
 * condição perguntar a ela. Zero migração, zero backfill.
 *
 * ─── Por que UNIR, e não trocar de caixa ───────────────────────────────────
 *
 * Trocar por `contacts.tags` consertaria o relato e apagaria a condição de quem
 * marca o NEGÓCIO — um campo que continua editável e deixaria de decidir fluxo,
 * que é a pior das faces. Unir não tira nada de ninguém: quem marcava no card
 * continua casando, e quem é marcado pela campanha passa a casar também.
 *
 * É a MESMA régua que o filtro do quadro já usa desde `marcadoresDoCard`
 * (`lib/kanban/marcadores-do-card.ts`), pelo mesmo motivo escrito lá.
 *
 * ─── O que isto NÃO é ─────────────────────────────────────────────────────
 *
 * Não é afrouxar a regra: o valor continua sendo comparado letra a letra
 * (`evaluateCheck`), e `neq` continua sendo negação de pertinência. O que muda
 * é a FONTE: a etiqueta que a campanha gravou no contato passa a contar como
 * etiqueta do lead — que é o que a tela sempre disse.
 *
 * A ordem é estável (negócio primeiro, contato depois) só para o resultado ser
 * determinístico; a comparação é de pertinência, não de posição.
 */
export function etiquetasDoLead(
  tagsDoNegocio: readonly string[] | null | undefined,
  tagsDoContato: readonly string[] | null | undefined,
): string[] {
  const vistas = new Set<string>();
  const etiquetas: string[] = [];
  for (const etiqueta of [...(tagsDoNegocio ?? []), ...(tagsDoContato ?? [])]) {
    // Linha de `text[]` chega bem formada do banco; a guarda é para o clone que
    // já viu `null` dentro do vetor e para o card sem contato (`undefined`).
    if (typeof etiqueta !== "string" || etiqueta === "") continue;
    if (vistas.has(etiqueta)) continue;
    vistas.add(etiqueta);
    etiquetas.push(etiqueta);
  }
  return etiquetas;
}
