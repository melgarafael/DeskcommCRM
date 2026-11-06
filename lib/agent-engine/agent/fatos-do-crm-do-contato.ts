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

/** Quantos funis distintos entram no bloco. */
export const MAX_FUNIS_NO_CLASSIFICADOR = 3;
/** Quantas etapas por funil (o contato pode ter dois cards abertos no mesmo funil). */
export const MAX_ETAPAS_POR_FUNIL = 2;
/** Quantas etiquetas entram no bloco. */
export const MAX_ETIQUETAS_NO_CLASSIFICADOR = 8;
/** Teto de cada nome (funil, etapa, etiqueta) — nome de funil é digitado à mão. */
export const MAX_CARACTERES_DE_NOME = 40;
/** Teto do bloco formatado inteiro, contando cabeçalho e marcadores. */
export const MAX_CARACTERES_DOS_FATOS = 600;

/** Um funil em que o contato tem negócio aberto, com as etapas desses cards. */
export interface FunilComNegocioAberto {
  funil: string;
  etapas: string[];
}

/** Os fatos que vão para o prompt. Listas vazias = não há o que informar. */
export interface FatosDoCrm {
  funis: FunilComNegocioAberto[];
  etiquetas: string[];
  /** Quantos funis ficaram fora do teto — o prompt diz que a lista não é completa. */
  funisOmitidos: number;
  /** Quantas etiquetas ficaram fora do teto. */
  etiquetasOmitidas: number;
}

/**
 * O resultado da leitura. `motivo` é o que vai para o log; `fatos` é o que vai
 * para o prompt. Os dois nunca se misturam: motivo é diagnóstico, não contexto.
 */
export interface LeituraDosFatosDoCrm {
  fatos: FatosDoCrm;
  motivo: 'contato_inexistente' | 'falha_na_leitura' | null;
}

/** Um card aberto, como a consulta devolve (nomes já resolvidos). */
export interface NegocioAbertoRow {
  funil: string | null;
  etapa: string | null;
}

const VAZIO: FatosDoCrm = { funis: [], etiquetas: [], funisOmitidos: 0, etiquetasOmitidas: 0 };

/**
 * Nome de config em uma linha só: sem quebra (nome colado no formulário não vira
 * fato novo no prompt), sem espaço duplicado, cortado no teto com reticências.
 */
export function normalizarNome(bruto: unknown): string {
  if (typeof bruto !== 'string') return '';
  const limpo = bruto.replace(/\s+/g, ' ').trim();
  if (limpo === '') return '';
  return limpo.length > MAX_CARACTERES_DE_NOME
    ? `${limpo.slice(0, MAX_CARACTERES_DE_NOME - 1)}…`
    : limpo;
}

/** Sem caixa e sem espaço: `Cliente ` e `cliente` são a mesma etiqueta. */
function chaveDeEtiqueta(tag: string): string {
  return tag.trim().toLowerCase();
}

/**
 * Monta o bloco a partir das linhas da consulta. Puro e exportado: é aqui que o
 * teto, a deduplicação e a ordem determinística se provam sem banco.
 *
 * Ordem alfabética de propósito — duas leituras do mesmo contato têm de produzir
 * o MESMO texto, senão o cache do provedor (prefixo estável) é inútil e um teste
 * de "o prompt leva estes fatos" passa a depender da ordem que o banco devolveu.
 */
export function montarFatosDoCrm(
  negocios: readonly NegocioAbertoRow[],
  etiquetasBrutas: readonly unknown[] | null | undefined,
): FatosDoCrm {
  const porFunil = new Map<string, { funil: string; etapas: Set<string> }>();
  for (const linha of negocios) {
    const funil = normalizarNome(linha?.funil);
    if (funil === '') continue;
    const atual = porFunil.get(funil) ?? { funil, etapas: new Set<string>() };
    const etapa = normalizarNome(linha?.etapa);
    if (etapa !== '') atual.etapas.add(etapa);
    porFunil.set(funil, atual);
  }

  const funis = [...porFunil.values()]
    .map((f) => ({ funil: f.funil, etapas: [...f.etapas].sort((a, b) => a.localeCompare(b, 'pt-BR')) }))
    .sort((a, b) => a.funil.localeCompare(b.funil, 'pt-BR'));

  const etiquetas: string[] = [];
  const vistas = new Set<string>();
  for (const bruta of etiquetasBrutas ?? []) {
    const tag = normalizarNome(bruta);
    if (tag === '') continue;
    const chave = chaveDeEtiqueta(tag);
    if (vistas.has(chave)) continue;
    vistas.add(chave);
    etiquetas.push(tag);
  }
  etiquetas.sort((a, b) => a.localeCompare(b, 'pt-BR'));

  return {
    funis: funis.slice(0, MAX_FUNIS_NO_CLASSIFICADOR).map((f) => ({
      funil: f.funil,
      etapas: f.etapas.slice(0, MAX_ETAPAS_POR_FUNIL),
    })),
    etiquetas: etiquetas.slice(0, MAX_ETIQUETAS_NO_CLASSIFICADOR),
    funisOmitidos: Math.max(0, funis.length - MAX_FUNIS_NO_CLASSIFICADOR),
    etiquetasOmitidas: Math.max(0, etiquetas.length - MAX_ETIQUETAS_NO_CLASSIFICADOR),
  };
}

/** Há algum fato para informar? Sem isso o bloco não entra no prompt. */
export function temFatosDoCrm(fatos: FatosDoCrm | null | undefined): fatos is FatosDoCrm {
  if (!fatos) return false;
  return fatos.funis.length > 0 || fatos.etiquetas.length > 0;
}

/**
 * O bloco em texto. `''` quando não há fato — um bloco dizendo "nenhum" custaria
 * tokens em toda mensagem para informar ausência que o classificador já trata
 * como "sem informação" (mesma direção de `renderCompromissos`).
 */
export function formatarFatosDoCrm(fatos: FatosDoCrm | null | undefined): string {
  if (!temFatosDoCrm(fatos)) return '';

  const linhas: string[] = [];
  for (const f of fatos.funis) {
    const etapas = f.etapas.length > 0 ? `, etapa ${f.etapas.map((e) => `"${e}"`).join(' / ')}` : '';
    linhas.push(`- Funil "${f.funil}"${etapas}: negócio ABERTO`);
  }
  if (fatos.etiquetas.length > 0) {
    linhas.push(`- Etiquetas do contato: ${fatos.etiquetas.join(', ')}`);
  }

  const omitidos: string[] = [];
  if (fatos.funisOmitidos > 0) omitidos.push(`${fatos.funisOmitidos} funil(is)`);
  if (fatos.etiquetasOmitidas > 0) omitidos.push(`${fatos.etiquetasOmitidas} etiqueta(s)`);
  if (omitidos.length > 0) {
    linhas.push(`- (o contato tem mais ${omitidos.join(' e ')} — a lista acima não é completa)`);
  }

  // Teto do bloco: corta por LINHA inteira, nunca no meio de um fato, e diz que
  // cortou — linha truncada no meio vira dado errado lido como verdadeiro.
  const cabem: string[] = [];
  let total = 0;
  for (const linha of linhas) {
    if (total + linha.length + 1 > MAX_CARACTERES_DOS_FATOS && cabem.length > 0) {
      cabem.push('- (mais fatos omitidos por limite de tamanho)');
      break;
    }
    cabem.push(linha);
    total += linha.length + 1;
  }
  return cabem.join('\n');
}

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
    if (primeira === undefined) return { fatos: VAZIO, motivo: 'contato_inexistente' };
    const etiquetas = Array.isArray(primeira.tags) ? primeira.tags : [];
    return { fatos: montarFatosDoCrm(rows, etiquetas), motivo: null };
  } catch {
    // O erro em si não é registrado aqui: quem chama tem o logger do turno e
    // registra o motivo. A função continua pura de log para poder ser testada
    // sem dublê de logger.
    return { fatos: VAZIO, motivo: 'falha_na_leitura' };
  }
}
