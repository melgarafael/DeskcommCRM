/**
 * PÚBLICO DO AGENTE — "atenda SÓ este grupo" / "NÃO atenda aquele" (#3722).
 *
 * ## O defeito que este arquivo existe para consertar
 *
 * A operação atende públicos diferentes no MESMO número: quem ainda não é
 * cliente (venda) e quem já tem contrato (suporte, cobrança, renovação). Até
 * aqui o produto não tinha nenhuma régua de PÚBLICO:
 *
 *  - `trigger_config.filters` conhecia `ignore_groups`, `ignore_self`,
 *    `keyword_regex` e `business_hours` — nada sobre quem é o contato;
 *  - com dois agentes publicados no número, a seleção (`agent-config.ts`)
 *    pegava UM (`order by pausado, priority desc, created_at asc limit 1`), e o
 *    outro nunca era escolhido: não havia como dividir o atendimento;
 *  - `pipeline_ids` do agente é ESCOPO DE ESCRITA (em que funil ele cria/move
 *    card), não critério de resposta.
 *
 * O caso medido pelo autor da issue: o agente de vendas responde o cliente com
 * contrato ativo que escreveu cobrando o contrato — e tenta vender para ele.
 *
 * ## O contrato (jsonb, sem migration)
 *
 * Quatro listas opcionais em `ai_agent_versions.trigger_config.filters`:
 * `include_tags`, `exclude_tags`, `include_pipeline_ids`,
 * `exclude_pipeline_ids`. Mora no jsonb da versão, como `keyword_regex` e
 * `business_hours`: nenhuma coluna nova, nenhuma migration.
 *
 * A régua é curta de propósito:
 *
 *  - OU dentro de cada lista, E entre as listas ("cumpre todas as restrições");
 *  - a EXCLUSÃO sempre vence — quem casa `exclude_tags` não passa nem que
 *    também case `include_tags`;
 *  - etiqueta é a do CONTATO (`contacts.tags`), sem diferença de maiúscula;
 *  - "estar no funil X" = o contato tem pelo menos um negócio ABERTO
 *    (`crm_leads.status = 'open'`) em X. Card ganho/perdido não conta — senão
 *    cliente antigo com card fechado voltaria a ser "do funil de vendas";
 *  - contato SEM negócio aberto não entra em "só estes funis" e NÃO é atingido
 *    por "não estes funis": o número novo, que ainda não tem card, passa por
 *    uma exclusão. É a direção que não cala quem chega.
 *
 * ## Falha ABERTA para configuração, FECHADA para leitura de dados
 *
 * Lista malformada (não-array, item que não é string, vazio) é IGNORADA — a
 * mesma direção do irmão `palavra-chave-do-gatilho.ts`: config torta vira "sem
 * filtro", nunca uma mordaça acidental. Já o erro ao LER os dados do contato
 * não é decidido no escuro: sobe e o job é re-tentado pela fila
 * (`failJob` → `max_attempts`), como manda a doutrina da casa. Silenciar por
 * causa de um timeout de banco é o defeito, não o conserto.
 *
 * ## O que este arquivo NÃO decide
 *
 * Ele responde "este contato passa neste público?" e nada mais. QUEM escolhe o
 * agente é `escolherAgenteDoNumero` (`agent-config.ts`) — o mesmo ponto onde a
 * escolha já acontecia. Não há caminho paralelo: o filtro roda dentro da
 * seleção, não antes dela.
 *
 * ## A resposta vem com o motivo (`avaliarPublico`)
 *
 * `passaNoPublico` devolve sim/não e é tudo de que a ESCOLHA precisa. Quem
 * investiga um turno precisa do resto — QUAL lista e QUAL item decidiram —, e
 * é isso que `avaliarPublico` devolve (e que vai para o rastro do turno em
 * `resolve-turn-agent.ts`). As duas funções são a MESMA régua: `passaNoPublico`
 * delega, e um teste de concordância sobre a matriz impede divergência.
 */
import type pg from 'pg';

/** O público declarado por uma versão do agente. Vazio = atende todo mundo. */
export interface PublicoDoAgente {
  /** Etiquetas (`contacts.tags`) que o contato PRECISA ter — uma basta. */
  incluirEtiquetas: readonly string[];
  /** Etiquetas que o contato NÃO pode ter. Vence qualquer inclusão. */
  excluirEtiquetas: readonly string[];
  /** Funis em que o contato precisa ter negócio aberto — um basta. */
  incluirFunis: readonly string[];
  /** Funis em que o contato NÃO pode ter negócio aberto. Vence a inclusão. */
  excluirFunis: readonly string[];
}

/** Os fatos do contato que a régua lê. Só o que ela usa. */
export interface FatosDoContato {
  /** `contacts.tags`. */
  etiquetas: readonly string[];
  /** `crm_leads.pipeline_id` dos negócios ABERTOS do contato. */
  funisAbertos: readonly string[];
}

/** Teto de cada lista — o mesmo tamanho de `pipeline_ids`/`tool_ids` na tela. */
export const TETO_DO_PUBLICO = 50;

function listaDeTexto(bruto: unknown): string[] {
  if (!Array.isArray(bruto)) return [];
  const saida: string[] = [];
  const vistas = new Set<string>();
  for (const item of bruto) {
    if (typeof item !== 'string') continue;
    const limpo = item.trim();
    if (limpo === '') continue;
    // Comparação sem caixa é do CONTRATO ("etiqueta é a do contato, sem
    // diferença de maiúscula"); guardar já normalizado evita repetir a conta em
    // cada turno e casa `Cliente` com `cliente` na mesma lista.
    const chave = limpo.toLowerCase();
    if (vistas.has(chave)) continue;
    vistas.add(chave);
    saida.push(limpo);
    if (saida.length >= TETO_DO_PUBLICO) break;
  }
  return saida;
}

/**
 * Lê o público de `trigger_config` (jsonb cru da versão publicada).
 *
 * `null` = nenhuma lista utilizável ⇒ o agente atende todo mundo, como antes.
 * É o valor que permite a seleção NEM LER os dados do contato: quem não
 * configurou público não paga consulta extra por turno.
 */
export function lerPublicoDoGatilho(triggerConfig: unknown): PublicoDoAgente | null {
  if (triggerConfig === null || typeof triggerConfig !== 'object') return null;
  const filters = (triggerConfig as { filters?: unknown }).filters;
  if (filters === null || typeof filters !== 'object') return null;
  const f = filters as Record<string, unknown>;
  const publico: PublicoDoAgente = {
    incluirEtiquetas: listaDeTexto(f.include_tags),
    excluirEtiquetas: listaDeTexto(f.exclude_tags),
    incluirFunis: listaDeTexto(f.include_pipeline_ids),
    excluirFunis: listaDeTexto(f.exclude_pipeline_ids),
  };
  const vazio =
    publico.incluirEtiquetas.length === 0 &&
    publico.excluirEtiquetas.length === 0 &&
    publico.incluirFunis.length === 0 &&
    publico.excluirFunis.length === 0;
  return vazio ? null : publico;
}

function chave(tag: string): string {
  return tag.trim().toLowerCase();
}

/**
 * Qual regra do público decidiu — o motivo que vai para o rastro do turno.
 *
 * Vocabulário FECHADO de propósito: o operador lê isto no log e procura a
 * mesma palavra na tela do agente. Cada valor nomeia a lista de onde veio a
 * decisão (`_excluida` = a lista de exclusão casou, `_exigida` = a de inclusão
 * não foi cumprida).
 */
export type RegraDoPublico =
  | 'passou'
  | 'barrado_por_etiqueta_excluida'
  | 'barrado_por_funil_excluido'
  | 'barrado_por_etiqueta_exigida'
  | 'barrado_por_funil_exigido';

/** A decisão de UM público sobre UM contato, com o motivo. */
export interface DecisaoDoPublico {
  passa: boolean;
  regra: RegraDoPublico;
  /**
   * O item DECLARADO no público que decidiu (etiqueta como o admin digitou, ou
   * `pipeline_id`). `null` quando a decisão não aponta um item do contato —
   * uma exigência não cumprida, ou a passagem limpa.
   *
   * É o item da CONFIG, nunca um dado do contato: é por isso que o rastro pode
   * ir para o log sem violar a disciplina de PII do call site.
   */
  valor: string | null;
}

/**
 * Este contato passa neste público, E POR QUÊ.
 *
 * Pura e sem banco: é a régua única. `passaNoPublico` delega aqui — a decisão e
 * o motivo não podem divergir (há teste de concordância sobre a matriz).
 *
 * A ordem é a da decisão: exclusão primeiro, porque ela vence.
 */
export function avaliarPublico(publico: PublicoDoAgente, fatos: FatosDoContato): DecisaoDoPublico {
  const temEtiqueta = new Set(fatos.etiquetas.map(chave));
  const abertos = new Set(fatos.funisAbertos);

  // 1. A EXCLUSÃO VENCE — nem a inclusão reabre.
  for (const tag of publico.excluirEtiquetas) {
    if (temEtiqueta.has(chave(tag))) {
      return { passa: false, regra: 'barrado_por_etiqueta_excluida', valor: tag };
    }
  }
  for (const funil of publico.excluirFunis) {
    if (abertos.has(funil)) {
      return { passa: false, regra: 'barrado_por_funil_excluido', valor: funil };
    }
  }

  // 2. Depois, TODAS as inclusões configuradas (E entre as listas, OU dentro).
  if (publico.incluirEtiquetas.length > 0) {
    const alguma = publico.incluirEtiquetas.some((tag) => temEtiqueta.has(chave(tag)));
    if (!alguma) return { passa: false, regra: 'barrado_por_etiqueta_exigida', valor: null };
  }
  if (publico.incluirFunis.length > 0) {
    const algum = publico.incluirFunis.some((funil) => abertos.has(funil));
    if (!algum) return { passa: false, regra: 'barrado_por_funil_exigido', valor: null };
  }
  return { passa: true, regra: 'passou', valor: null };
}

/**
 * Este contato passa neste público?
 *
 * A resposta de sim/não que a escolha do agente consome. Delega em
 * `avaliarPublico` para não existir uma segunda cópia da régua.
 */
export function passaNoPublico(publico: PublicoDoAgente, fatos: FatosDoContato): boolean {
  return avaliarPublico(publico, fatos).passa;
}

/**
 * Os fatos do contato: etiquetas da ficha + funis dos negócios ABERTOS.
 *
 * Uma consulta, não duas: a seleção do agente roda em todo turno e o público é
 * opcional — quem paga é só quem configurou.
 *
 * Contato inexistente (apagado entre o despacho e o turno) devolve fatos
 * VAZIOS, não erro: sem etiqueta e sem card ele simplesmente não entra em "só
 * estes" e não é atingido por "não estes". Erro de banco SOBE — quem chama
 * deixa a fila re-tentar; decidir no escuro calaria o cliente.
 */
export async function carregarFatosDoContato(
  db: Pick<pg.Pool, 'query'>,
  organizationId: string,
  contactId: string,
): Promise<FatosDoContato> {
  const { rows } = await db.query<{ tags: string[] | null; funis: string[] | null }>(
    `select c.tags,
            (select array_agg(distinct l.pipeline_id::text)
               from crm_leads l
              where l.organization_id = $1
                and l.contact_id = $2
                and l.status = 'open') as funis
       from contacts c
      where c.organization_id = $1 and c.id = $2`,
    [organizationId, contactId],
  );
  const r = rows[0];
  if (r === undefined) return { etiquetas: [], funisAbertos: [] };
  return {
    etiquetas: (r.tags ?? []).filter((t): t is string => typeof t === 'string'),
    funisAbertos: (r.funis ?? []).filter((f): f is string => typeof f === 'string'),
  };
}
