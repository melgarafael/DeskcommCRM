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

import { anexarCamposDoFunil } from "./campos-do-render";
import { anexarOpcoesDoRender } from "./opcoes-do-render";
import { camposDoFunil } from "@/lib/leads/campos-do-funil";
import { fusoDaOrganizacao } from "./cron-de-data";
import { resolverVariaveis, saudacaoDaHora, type InstanteDoEnvio } from "@/lib/variaveis/resolvedor";

/**
 * O corpo da mensagem com as marcações de CRM resolvidas.
 *
 * `contexto` é o MESMO objeto que a automação monta (`{ contact, lead }` —
 * linhas inteiras de `contacts` e `crm_leads`), então `{{nome}}`,
 * `{{contact.phone_number}}`, `{{lead.title}}` e o atalho de campo personalizado
 * (`{{servico}}` → `lead.custom_fields.servico`) resolvem igualzinho lá.
 */
export function renderizarTextoDeFollowup(
  texto: string,
  contexto: Record<string, unknown>,
  agora?: InstanteDoEnvio,
): string {
  // A MESMA conta da automação, com a política desta tela: `remover` tira a
  // marcação sem valor JUNTO com o espaço vizinho ("Oi {{primeiro_nome}}!" →
  // "Oi!"), que é a régua do #2528. `agora` é o instante do envio — é ele que
  // faz `{{saudacao}}` sair igual à campanha.
  return resolverVariaveis(texto, contexto, {
    fonte: "automacao",
    quandoVazio: "remover",
    agora,
  }).texto;
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
  const [contatos, negocios, organizacao] = await Promise.all([
    pool.query<Record<string, unknown>>(
      `select * from contacts where organization_id = $1 and id = $2 limit 1`,
      [organizationId, contactId],
    ),
    pool.query<Record<string, unknown>>(
      `select * from crm_leads where organization_id = $1 and contact_id = $2 order by updated_at desc limit 1`,
      [organizationId, contactId],
    ),
    // O idioma e o fuso da empresa alimentam `{{campo|data}}` (#4339) — mesma
    // régua da automação, uma leitura a mais pela PK.
    pool.query<{ locale: string | null; timezone: string | null }>(
      `select locale, timezone from organizations where id = $1 limit 1`,
      [organizationId],
    ),
  ]);
  const contexto: Record<string, unknown> = {};
  anexarOpcoesDoRender(contexto, {
    idioma: organizacao.rows[0]?.locale,
    fuso: organizacao.rows[0]?.timezone,
  });
  if (contatos.rows[0]) contexto.contact = contatos.rows[0];
  if (negocios.rows[0]) contexto.lead = negocios.rows[0];

  // `{{saudacao}}` (#3687): o follow-up não tem a sessão do canal em mãos, então
  // o fuso é o da ORGANIZAÇÃO — o mesmo que a janela usa como reserva
  // (`fusoDaJanela`). Calculada aqui, no mesmo instante do envio: quem chama só
  // tem o texto e o contexto.
  const fuso = await pool.query<{ timezone: string | null }>(
    `select timezone from organizations where id = $1 limit 1`,
    [organizationId],
  );
  contexto.saudacao = saudacaoDaHora(new Date(), fusoDaOrganizacao(fuso.rows[0]?.timezone));

  // O rótulo das opções (#3605): a linha do negócio guarda o CÓDIGO
  // (`paris-franca`) e o funil guarda o que o cliente deve ler. Uma leitura a
  // mais, e só quando há campo personalizado preenchido — sem ela o follow-up
  // mandaria o código enquanto a automação manda o rótulo, para o mesmo campo.
  const lead = negocios.rows[0];
  const temCampos =
    !!lead?.custom_fields &&
    typeof lead.custom_fields === "object" &&
    Object.keys(lead.custom_fields as Record<string, unknown>).length > 0;
  if (temCampos && typeof lead?.pipeline_id === "string") {
    const { rows } = await pool.query<{ settings: Record<string, unknown> | null }>(
      `select settings from crm_pipelines where organization_id = $1 and id = $2 limit 1`,
      [organizationId, lead.pipeline_id],
    );
    anexarCamposDoFunil(contexto, camposDoFunil(rows[0]?.settings ?? null));
  }

  return contexto;
}
