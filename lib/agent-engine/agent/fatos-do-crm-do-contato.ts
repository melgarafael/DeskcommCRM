/**
 * FATOS DO CRM DO CONTATO NO CLASSIFICADOR DO ROTEADOR (#3917, pedido 2).
 *
 * ─── O que faltava ──────────────────────────────────────────────────────────
 *
 * O classificador de intenção recebia só o texto da mensagem e uma janela curta
 * da conversa (`buildClassifierPrompt`). Ele não tinha como saber que o contato
 * JÁ é cliente: numa agência de viagens com dois membros no mesmo número, a
 * cliente com viagem fechada para Nova York escreveu "Bom dia! Tudo bem?" e o
 * roteador a mandou para a Clara (vendas, "saudação sem assunto"); na mensagem
 * seguinte, "Agradeço", foi para a Heloísa (pós-venda). Duas despedidas
 * diferentes na mesma conversa.
 *
 * ─── O que este arquivo entrega ─────────────────────────────────────────────
 *
 * Os fatos que a decisão precisa e que o texto não carrega:
 *
 *  - funis e ETAPAS onde o contato tem negócio ABERTO (`crm_leads.status =
 *    'open'`), com o NOME que o operador vê na tela;
 *  - as etiquetas do contato (`contacts.tags`).
 *
 * A leitura é a MESMA régua do público do agente (#3722,
 * `publico-do-gatilho.ts`): `crm_leads.status = 'open'`, escopada por
 * `organization_id`. Card ganho/perdido fica de fora — cliente antigo com card
 * fechado voltaria a parecer "do funil de vendas", que é exatamente o erro que
 * o #3722 fechou. Aqui só se acrescenta o NOME do funil e da etapa, que o
 * público não precisava (ele compara ids) e o classificador precisa (ele lê
 * texto).
 *
 * ─── PII ────────────────────────────────────────────────────────────────────
 *
 * O bloco leva NOME de funil, NOME de etapa e ETIQUETA — configuração da
 * empresa. Nunca o título do card (que é escrito à mão e costuma ter nome de
 * pessoa: "Viagem da Maria"), nunca telefone, e-mail, CPF ou valor. O log leva
 * só CONTAGENS, pelo mesmo motivo.
 *
 * ─── Falha ABERTA, ao contrário do público ──────────────────────────────────
 *
 * `carregarFatosDoContato` (#3722) deixa o erro SUBIR: ali os fatos decidem se
 * o contato é atendido, e decidir no escuro calaria o cliente. Aqui os fatos
 * são adjetivo da classificação — sem eles o roteamento de hoje continua
 * válido. Por isso a leitura NUNCA lança: devolve o motivo, o chamador registra
 * e o turno classifica como antes. Uma consulta lenta não pode derrubar o
 * atendimento só porque o classificador ficaria mais esperto.
 *
 * ─── Teto, e por que ele não é zelo ─────────────────────────────────────────
 *
 * O bloco entra no prompt do classificador, que roda em TODO turno com
 * mensagem inbound — o custo é por mensagem. Um contato com 20 etiquetas e 15
 * cards abertos pagaria tudo isso em cada "bom dia". Os tetos de funil e de
 * etiqueta cortam e DIZEM que cortaram: truncar em silêncio faria o modelo
 * afirmar que o cliente só tem aqueles funis. O teto de etapas corta calado: o
 * funil continua listado, que é o que a decisão mais precisa.
 */
import type pg from 'pg';

import { FATOS_VAZIOS, montarFatosDoCrm, type LeituraDosFatosDoCrm } from '@/lib/leads/fatos-do-crm-no-prompt';

// A forma e a formatação moram em `lib/leads/fatos-do-crm-no-prompt.ts`, longe
// do módulo que o Jev importa (cerca do #3917). Reexportadas para que quem já
// lia daqui continue lendo daqui.
export * from '@/lib/leads/fatos-do-crm-no-prompt';

/**
 * Lê os fatos do contato: etiquetas da ficha e funis/etapas dos negócios ABERTOS.
 *
 * Uma consulta só, com `left join`: contato sem card nenhum devolve UMA linha com
 * os funis nulos (e as etiquetas), que `montarFatosDoCrm` transforma em listas
 * vazias. Contato inexistente (apagado entre o despacho e o turno) devolve
 * `contato_inexistente` — sem PII e sem erro.
 *
 * Erro de banco NÃO sobe: vira `falha_na_leitura` com fatos vazios. O chamador
 * registra o motivo e o classificador roda como antes da #3917.
 */
export async function carregarFatosDoCrmDoContato(
  db: Pick<pg.Pool, 'query'>,
  organizationId: string,
  contactId: string,
): Promise<LeituraDosFatosDoCrm> {
  try {
    const { rows } = await db.query<{ tags: unknown; funil: string | null; etapa: string | null }>(
      `select c.tags,
              p.name as funil,
              s.name as etapa
         from contacts c
         left join crm_leads l
                on l.organization_id = c.organization_id
               and l.contact_id = c.id
               and l.status = 'open'
         left join crm_pipelines p
                on p.id = l.pipeline_id
               and p.organization_id = l.organization_id
         left join crm_stages s
                on s.id = l.stage_id
               and s.organization_id = l.organization_id
        where c.organization_id = $1
          and c.id = $2
        order by p.name, s.name`,
      [organizationId, contactId],
    );
    const primeira = rows[0];
    if (primeira === undefined) return { fatos: FATOS_VAZIOS, motivo: 'contato_inexistente' };
    const etiquetas = Array.isArray(primeira.tags) ? primeira.tags : [];
    return { fatos: montarFatosDoCrm(rows, etiquetas), motivo: null };
  } catch {
    // O erro em si não é registrado aqui: quem chama tem o logger do turno e
    // registra o motivo. A função continua pura de log para poder ser testada
    // sem dublê de logger.
    return { fatos: FATOS_VAZIOS, motivo: 'falha_na_leitura' };
  }
}
