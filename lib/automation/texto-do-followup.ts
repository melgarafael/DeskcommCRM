/**
 * O texto da mensagem de follow-up com os dados do contato e do negócio (#2528).
 *
 * Dois porquês, e nenhum deles é um renderizador novo:
 *
 * 1. REAPROVEITA o renderizador das automações (`lib/automation/template.ts`).
 *    Follow-up passa a falar `{{nome}}`, `{{primeiro_nome}}`, `{{contact.*}}` e
 *    `{{lead.*}}` — o MESMO vocabulário de automação, campanha e Inbox. Antes
 *    desta correção só `{{volta}}`/`{{voltas}}` saíam preenchidos: o resto
 *    chegava ao cliente como `{{primeiro_nome}}` cru.
 *
 * 2. A RÉGUA DA ISSUE vale inteira: variável sem valor NUNCA sai como
 *    `{{...}}` cru nem como "Olá , tudo bem?" — a marcação sai da frase JUNTO
 *    com o espaço vizinho ("Oi {{primeiro_nome}}!" → "Oi!"; "Olá {{nome}},
 *    tudo?" → "Olá, tudo?"). É por isso que a chamada é TOKEN A TOKEN: o
 *    `renderTemplate` sozinho devolveria a string vazia e deixaria o espaço
 *    órfão no lugar, que é o defeito que a issue nomeou.
 *
 * A ordem com quem chama importa: `{{volta}}`/`{{voltas}}` são interpolados
 * ANTES (senão o render os apagaria, não sendo campo de CRM).
 */
import type pg from "pg";

import { renderTemplate } from "./template";

/** Só palavra e ponto, como no renderizador das automações — o destino de todo o resto é ficar como está. */
const MARCA = /\{\{\s*([\w.]+)\s*\}\}/g;

/**
 * O corpo da mensagem com as marcações de CRM resolvidas.
 *
 * `contexto` é o MESMO objeto que a automação monta (`{ contact, lead }` —
 * linhas inteiras de `contacts` e `crm_leads`), então `{{nome}}`,
 * `{{contact.phone_number}}`, `{{lead.title}}` e o atalho de campo personalizado
 * (`{{servico}}` → `lead.custom_fields.servico`) resolvem igualzinho lá.
 */
export function renderizarTextoDeFollowup(texto: string, contexto: Record<string, unknown>): string {
  let saida = "";
  let cursor = 0;
  let algumaFicouVazia = false;
  for (const marca of texto.matchAll(MARCA)) {
    const inicio = marca.index ?? cursor;
    saida += texto.slice(cursor, inicio);
    const valor = renderTemplate(marca[0], contexto);
    if (valor === "") {
      // Marca sem valor: some ela e o espaço que ficaria órfão do lado esquerdo.
      saida = saida.replace(/\s+$/, "");
      algumaFicouVazia = true;
    } else {
      saida += valor;
    }
    cursor = inicio + marca[0].length;
  }
  saida += texto.slice(cursor);
  // Sem valor no INÍCIO da frase ("{{nome}} chegou"), o espaço do segundo
  // pedaço também não pode sobrar — " chegou" não é frase.
  return algumaFicouVazia ? saida.replace(/^\s+/, "") : saida;
}

/**
 * O contexto do render (`{ contact, lead }`) lido do Postgres pelo worker 24/7.
 *
 * O MESMO par de consultas que `loadLeadFacts` faz, mas com as linhas INTEIRAS:
 * o renderizador resolve caminho (`{{contact.email}}`, `{{lead.title}}`), e
 * caminho é coluna, não fato condensado. O negócio é o mais recente do contato
 * (`updated_at desc`), igualzinho à escolha de `loadLeadFacts` — dois caminhos
 * que escolhem negócios diferentes dariam nomes diferentes na mesma mensagem.
 */
export async function contextoDoContato(
  pool: pg.Pool,
  organizationId: string,
  contactId: string,
): Promise<Record<string, unknown>> {
  const [contatos, negocios] = await Promise.all([
    pool.query<Record<string, unknown>>(
      `select * from contacts where organization_id = $1 and id = $2 limit 1`,
      [organizationId, contactId],
    ),
    pool.query<Record<string, unknown>>(
      `select * from crm_leads where organization_id = $1 and contact_id = $2 order by updated_at desc limit 1`,
      [organizationId, contactId],
    ),
  ]);
  const contexto: Record<string, unknown> = {};
  if (contatos.rows[0]) contexto.contact = contatos.rows[0];
  if (negocios.rows[0]) contexto.lead = negocios.rows[0];
  return contexto;
}
