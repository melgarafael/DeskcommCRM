/**
 * O NEGÓCIO DO CONTATO NO TURNO DE IA DE UM FLUXO DE FOLLOW-UP.
 *
 * O passo `action` em modo `ai_message` escreve a mensagem com o contexto do
 * CONTATO (`get_lead_context`: nome, tags, origem, histórico). O card do
 * negócio — título, etapa, descrição e campos do funil — nunca chegava ao
 * modelo. Medido numa instalação real: o card trazia "fiz a visita na obra,
 * são 2 casas, o construtor é o Carlão, preciso falar do INSS da obra", a
 * instrução do passo mandava "leia o card do negócio", e a mensagem saiu com
 * "aquela obra que conversamos" — o modelo preencheu o vazio com generalidade,
 * porque não havia o que ler.
 *
 * QUAL NEGÓCIO: o mais recente por `updated_at`, a MESMA regra de
 * `loadRenderContext`/`loadLeadFacts` (`lib/followup/engine.ts`) e de
 * `dadosParaVariaveis` (`followup-turn.ts`). Duas regras dariam ao texto fixo e
 * à IA negócios diferentes para o mesmo contato. Mover o card de etapa carimba
 * `updated_at`, então no gatilho por etapa o negócio movido é o escolhido.
 *
 * QUAIS CAMPOS: só os do NEGÓCIO declarados no funil (`escopo` ausente ou
 * `negocio`), com o rótulo que a organização deu, e só os preenchidos. Chave de
 * `custom_fields` que o funil não declara fica de fora — sem rótulo não há como
 * o modelo saber o que o valor significa. Arquivo fica de fora: é URL de
 * storage, não contexto.
 *
 * NUNCA DERRUBA O TURNO: o bloco é ACRÉSCIMO. Falhou a leitura, o turno segue
 * exatamente como era antes deste arquivo existir (ver `carregarBlocoDoNegocio`).
 */
import type pg from 'pg';

import { camposDoFunil, camposPorEscopo } from '@/lib/leads/campos-do-funil';
import type { CustomFieldDef } from '@/lib/schemas/settings';

/** Teto da descrição no prompt — o card pode ser um diário de obra inteiro. */
export const TETO_DA_DESCRICAO = 2000;

export interface NegocioDoFollowup {
  title: string | null;
  description: string | null;
  stage_name: string | null;
  custom_fields: Record<string, unknown> | null;
  pipeline_settings: Record<string, unknown> | null;
}

function textoLimpo(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

function rotuloDaOpcao(campo: CustomFieldDef, valor: unknown): string {
  const opcao = campo.options?.find((o) => o.value === valor);
  return opcao ? opcao.label : String(valor);
}

/** O valor do campo como uma pessoa o leria na tela; `null` = vazio, não entra. */
export function valorLegivel(campo: CustomFieldDef, valor: unknown): string | null {
  if (valor === null || valor === undefined) return null;
  if (campo.type === 'file') return null;
  if (campo.type === 'boolean') return valor === true ? 'Sim' : valor === false ? 'Não' : null;
  if (Array.isArray(valor)) {
    const itens = valor.filter((v) => v !== null && v !== undefined && String(v).trim() !== '');
    return itens.length === 0 ? null : itens.map((v) => rotuloDaOpcao(campo, v)).join(', ');
  }
  if (typeof valor === 'object') return null;
  if (campo.type === 'select' || campo.type === 'searchable_select') {
    return textoLimpo(String(valor)) === null ? null : rotuloDaOpcao(campo, valor);
  }
  return textoLimpo(String(valor));
}

/**
 * O bloco que entra no prompt. PURA. String vazia quando o negócio não tem
 * nada que valha a leitura — o chamador então não acrescenta nada.
 */
export function blocoDoNegocio(negocio: NegocioDoFollowup | null): string {
  if (!negocio) return '';
  const linhas: string[] = [];
  const titulo = textoLimpo(negocio.title);
  const etapa = textoLimpo(negocio.stage_name);
  if (titulo) linhas.push(`Título: ${titulo}`);
  if (etapa) linhas.push(`Etapa atual: ${etapa}`);

  const custom = negocio.custom_fields ?? {};
  const campos = camposPorEscopo(camposDoFunil(negocio.pipeline_settings), 'negocio');
  for (const campo of campos) {
    const v = valorLegivel(campo, custom[campo.key]);
    if (v !== null) linhas.push(`${campo.label}: ${v}`);
  }

  const descricaoInteira = textoLimpo(negocio.description);
  if (descricaoInteira) {
    const descricao =
      descricaoInteira.length > TETO_DA_DESCRICAO
        ? `${descricaoInteira.slice(0, TETO_DA_DESCRICAO)}… (descrição cortada)`
        : descricaoInteira;
    linhas.push('Descrição (anotações da equipe):', descricao);
  }

  // Só título não é contexto — todo card tem um. Sem etapa, campo ou
  // descrição, o bloco não acrescenta nada que o nome do contato já não diga.
  if (linhas.length === 0 || (linhas.length === 1 && titulo)) return '';

  return [
    '## Negócio deste contato (card do CRM)',
    'O que a equipe registrou no card. É contexto INTERNO: use-o para personalizar a mensagem,',
    'sem copiar as anotações nem expor detalhe que o cliente não deveria ler. Não invente o que não está aqui.',
    ...linhas,
  ].join('\n');
}

/**
 * Lê o negócio e devolve o bloco. Erro de leitura → string vazia e um aviso no
 * log: o turno nunca cai por causa deste acréscimo.
 */
export async function carregarBlocoDoNegocio(
  pool: Pick<pg.Pool, 'query'>,
  tenantId: string,
  contactId: string,
  log?: { warn: (msg: string, fields?: Record<string, unknown>) => void },
): Promise<string> {
  try {
    const { rows } = await pool.query<NegocioDoFollowup>(
      `select l.title, l.description, s.name as stage_name, l.custom_fields, p.settings as pipeline_settings
         from crm_leads l
         left join crm_stages s on s.id = l.stage_id and s.organization_id = l.organization_id
         left join crm_pipelines p on p.id = l.pipeline_id and p.organization_id = l.organization_id
        where l.organization_id = $1 and l.contact_id = $2
        order by l.updated_at desc
        limit 1`,
      [tenantId, contactId],
    );
    return blocoDoNegocio(rows?.[0] ?? null);
  } catch (err) {
    log?.warn('bloco do negócio fora do turno de follow-up — leitura falhou', {
      error: err instanceof Error ? err.message : String(err),
    });
    return '';
  }
}
