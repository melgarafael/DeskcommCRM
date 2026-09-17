import { chaveDeNome, slugDeNome } from "@/lib/leads/stage-editing";

/**
 * As regras da edição dos FUNIS, sem tocar no banco.
 *
 * O andar de baixo (etapas) já tem o seu par em `lib/leads/stage-editing.ts`, e
 * este arquivo é deliberadamente simétrico a ele: mesma forma de `Resultado`,
 * mesmas mensagens em português citando o NOME, mesma separação entre validar e
 * traduzir em UPDATEs. Quem entender um entende o outro.
 *
 * ⚠️ ARQUIVAR, NÃO APAGAR — e por três motivos independentes, não um:
 * `crm_leads_pipeline_id_fkey` é `ON DELETE RESTRICT` (o banco recusa funil com
 * negócio), `webhook_sources.default_pipeline_id` é `ON DELETE CASCADE` (apagar o
 * funil apagaria a fonte de webhook do cliente EM SILÊNCIO, e o formulário
 * público pararia de captar lead), e `automation_rules.actions` cita
 * `pipeline_id` dentro de jsonb SEM FK nenhuma — ali o banco não defende nada, e
 * a regra sobreviveria apontando para o vazio.
 *
 * ⚠️ AS DEPENDÊNCIAS SÃO CONTADAS FORA DAQUI. Este módulo recebe
 * `DependenciasDoFunil` já resolvido porque as três consultas moram na borda do
 * banco (`app/api/v1/pipelines/_funis.ts`) — o que mantém as regras puras e
 * testáveis sem subir Postgres.
 */

/** O que as regras precisam saber de cada funil. Inclui os arquivados — quem filtra é este módulo. */
export interface FunilEditavel {
  id: string;
  name: string;
  slug: string;
  position: number;
  is_default: boolean;
  /**
   * Onde nasce o lead de quem já é cliente (migration 0262). Opcional porque um
   * chamador que só troca nome ou posição não precisa carregá-la, e porque a
   * coluna é nova: um objeto montado antes dela continua compilando.
   */
  is_client_pipeline?: boolean;
  is_archived: boolean;
  /** Opcional porque NENHUMA regra daqui a usa — ela só existe para a tela. */
  description?: string | null;
}

/** O que amarra o funil ao resto do sistema, contado ANTES de arquivar ou excluir. */
export interface DependenciasDoFunil {
  /** Negócios (`crm_leads`) apontando para o funil. */
  negocios: number;
  /** Nomes das fontes de webhook que têm este funil como destino padrão. */
  fontesDeWebhook: string[];
  /** Nomes das automações ATIVAS que mandam card para este funil. */
  regrasAtivas: string[];
}

export type Resultado = { ok: true } | { ok: false; erro: string };

/** Só os funis que disputam nome e aparecem na lista. */
function ativos(funis: FunilEditavel[]): FunilEditavel[] {
  return funis.filter((f) => !f.is_archived);
}

function lista(nomes: string[]): string {
  return nomes.map((n) => `«${n}»`).join(", ");
}

/**
 * Slug técnico do funil, só na criação.
 *
 * A conta é a mesma das etapas (`crm_pipelines_slug_format` e
 * `crm_stages_slug_format` são o MESMO formato) — o que muda é a raiz de
 * emergência: um funil chamado só de emoji vira `funil`, não `etapa`.
 *
 * `slugsExistentes` deve incluir os dos ARQUIVADOS: `uniq_crm_pipelines_org_slug`
 * não é parcial, funil fora da lista continua ocupando o slug.
 */
export function slugDeFunil(nome: string, slugsExistentes: string[] = []): string {
  return slugDeNome(nome, slugsExistentes, "funil");
}

/**
 * Recusa o nome que o usuário leria como duplicado.
 *
 * `funilId` é o funil sendo renomeado (`null` na criação): sem isso, renomear
 * "Clínica" para "Clínica" colidiria consigo mesmo.
 */
export function validarNomeDeFunil(
  nome: string,
  funis: FunilEditavel[],
  funilId: string | null,
): Resultado {
  if (!nome.trim()) {
    return { ok: false, erro: "Dê um nome ao funil — é o que aparece na lista e no topo do quadro." };
  }

  const chave = chaveDeNome(nome);
  // Arquivados não entram: recusar por causa de um funil que sumiu da lista
  // seria um erro sem saída — o usuário não consegue nem ver o que colidiu.
  const colisao = ativos(funis).find((f) => f.id !== funilId && chaveDeNome(f.name) === chave);
  if (colisao) {
    return { ok: false, erro: `Já existe um funil chamado «${colisao.name}». Escolha outro nome.` };
  }

  return { ok: true };
}

/**
 * Recusa o arquivamento que deixaria a operação sem quadro ou quebraria uma entrada de lead.
 *
 * ⚠️ A ORDEM DAS RECUSAS É A ORDEM DO QUE O USUÁRIO CONSEGUE RESOLVER. Quem tem
 * um funil só tem o funil padrão por definição: mandá-lo "eleger outro padrão"
 * seria um beco sem saída. Por isso a unicidade vem antes de tudo.
 */
export function validarArquivamento(
  funis: FunilEditavel[],
  funilId: string,
  deps: DependenciasDoFunil,
): Resultado {
  const funil = funis.find((f) => f.id === funilId);
  if (!funil) {
    return { ok: false, erro: "Esse funil não está mais na sua lista. Recarregue a página e tente de novo." };
  }

  if (ativos(funis).filter((f) => f.id !== funilId).length === 0) {
    return {
      ok: false,
      erro:
        `«${funil.name}» é o único funil ativo. Sem nenhum funil não há quadro para abrir nem para onde ` +
        `mandar negócio novo — crie outro funil antes de arquivar este.`,
    };
  }

  if (funil.is_default) {
    return {
      ok: false,
      erro:
        `«${funil.name}» é o funil padrão: é para ele que vai o negócio criado sem funil escolhido. ` +
        `Marque OUTRO funil como padrão antes de arquivar este.`,
    };
  }

  if (deps.fontesDeWebhook.length > 0) {
    const plural = deps.fontesDeWebhook.length > 1;
    // ⚠️ A FRASE NÃO AFIRMA QUE A ENTRADA VAI PARAR, e a diferença não é
    // estilo: a contagem inclui fonte DESATIVADA (a exclusão a levaria junto
    // pelo cascade), e prometer que "o lead pararia de chegar" seria falso para
    // ela. O que vale nos dois casos é o vínculo, e é o vínculo que se diz.
    return {
      ok: false,
      erro:
        `«${funil.name}» é o destino ${plural ? "dos formulários" : "do formulário"} ${lista(deps.fontesDeWebhook)}. ` +
        `Aponte ${plural ? "os formulários" : "o formulário"} para outro funil antes de arquivar este — senão o lead ` +
        `que chegar por ${plural ? "eles" : "ele"} fica sem quadro.`,
    };
  }

  if (deps.regrasAtivas.length > 0) {
    const plural = deps.regrasAtivas.length > 1;
    return {
      ok: false,
      erro:
        `${plural ? "As automações" : "A automação"} ${lista(deps.regrasAtivas)} ${plural ? "mandam" : "manda"} card para ` +
        `«${funil.name}». Ajuste ${plural ? "essas automações" : "essa automação"} antes de arquivar o funil.`,
    };
  }

  // Funil COM negócios arquiva: some da lista e do seletor, o histórico continua
  // apontando para ele. É exatamente o que arquivar existe para fazer.
  return { ok: true };
}

/**
 * Recusa a exclusão definitiva — a operação que não tem volta.
 *
 * Herda TODA recusa do arquivamento de propósito: excluir é mais grave que
 * arquivar, então nunca pode ser mais permissivo. O que sobra é o caso honesto do
 * "criei sem querer": funil que nunca recebeu negócio nenhum.
 */
export function podeExcluirDeVez(
  funis: FunilEditavel[],
  funilId: string,
  deps: DependenciasDoFunil,
): Resultado {
  const antes = validarArquivamento(funis, funilId, deps);
  if (!antes.ok) return antes;

  if (deps.negocios > 0) {
    const funil = funis.find((f) => f.id === funilId)!;
    const n = deps.negocios;
    return {
      ok: false,
      erro:
        `«${funil.name}» tem ${n} ${n === 1 ? "negócio" : "negócios"}, e o histórico ${n === 1 ? "dele" : "deles"} ` +
        `aponta para este funil. Arquive em vez de excluir — o funil sai da lista e nada se perde.`,
    };
  }

  return { ok: true };
}

/** As marcas exclusivas que um funil pode carregar — uma por organização, cada uma. */
export type MarcaExclusiva = "is_default" | "is_client_pipeline";

export interface UpdateDePadrao {
  pipelineId: string;
  patch: Partial<Record<MarcaExclusiva, boolean>>;
}

/**
 * A troca de uma marca exclusiva de funil traduzida nos UPDATEs, NA ORDEM EM QUE
 * PRECISAM SAIR.
 *
 * ⚠️ A LIBERAÇÃO DO ANTERIOR VEM PRIMEIRO, e não é estética: os dois índices
 * (`uniq_crm_pipelines_org_default` e `uniq_crm_pipelines_org_client`) são
 * imediatos (não deferíveis), então marcar o novo antes de liberar o antigo é um
 * `23505` cru na cara de quem só queria trocar. Mesmo desenho de
 * `updatesDeMarcacao` para etapas.
 *
 * ⚠️ O ANTERIOR É PROCURADO ENTRE TODOS OS FUNIS, ARQUIVADOS INCLUSIVE — e este
 * parágrafo corrige uma afirmação que estava aqui e era falsa. O comentário
 * anterior dizia que o índice de padrão é parcial em `is_archived`; medido em
 * `supabase/baseline.sql`, ele é `where (is_default = true)` e mais nada. Quem
 * pulava o arquivado deixava o banco com dois marcados para liberar um só, e o
 * 23505 aparecia justamente na organização que arquivou o funil antigo em vez de
 * trocar o padrão antes — o caminho mais comum de quem reorganiza o CRM.
 */
export function updatesDeMarcaExclusiva(
  funis: FunilEditavel[],
  novoId: string,
  marca: MarcaExclusiva,
): UpdateDePadrao[] {
  const novo = funis.find((f) => f.id === novoId);
  if (!novo || novo[marca]) return [];

  const updates: UpdateDePadrao[] = [];
  const anterior = funis.find((f) => f.id !== novoId && f[marca]);
  if (anterior) updates.push({ pipelineId: anterior.id, patch: { [marca]: false } });

  updates.push({ pipelineId: novoId, patch: { [marca]: true } });
  return updates;
}

/** O nome que o resto do código já importa. Um caso de `updatesDeMarcaExclusiva`. */
export function updatesDePadrao(funis: FunilEditavel[], novoId: string): UpdateDePadrao[] {
  return updatesDeMarcaExclusiva(funis, novoId, "is_default");
}

/** Uma regra de automação como ela sai do banco — `actions` é jsonb cru. */
export interface RegraDeAutomacao {
  name: string;
  is_active: boolean;
  actions: unknown;
}

/**
 * Nomes das automações ativas que citam este funil.
 *
 * ⚠️ TUDO AQUI É DEFENSIVO PORQUE `actions` NÃO TEM SCHEMA NO BANCO. É jsonb sem
 * FK e sem CHECK: uma regra antiga, ou escrita por outra versão do produto, pode
 * ter qualquer forma. Uma exceção neste laço viraria um 500 no arquivamento —
 * erro técnico no lugar de uma pergunta simples sobre o funil.
 */
export function regrasQueApontamPara(regras: RegraDeAutomacao[], pipelineId: string): string[] {
  const nomes: string[] = [];
  for (const regra of regras) {
    if (!regra.is_active || !Array.isArray(regra.actions)) continue;
    const cita = regra.actions.some((acao) => {
      const config = (acao as { config?: unknown } | null)?.config;
      if (!config || typeof config !== "object") return false;
      return (config as { pipeline_id?: unknown }).pipeline_id === pipelineId;
    });
    if (cita) nomes.push(regra.name);
  }
  return nomes;
}

/**
 * As etapas com que um funil novo nasce.
 *
 * ⚠️ FUNIL SEM ETAPA É QUADRO MORTO — a doutrina do sistema vivo em uma linha: o
 * board abriria sem coluna nenhuma e não receberia negócio. E a etapa de GANHO
 * não é enfeite: `/leads/[id]/win` procura `is_won` e responde 422
 * `pipeline_no_won_stage` sem ela, ou seja, o funil nasceria incapaz de fechar
 * negócio.
 *
 * Os nomes são neutros de propósito. O gatilho `fn_seed_default_pipeline_for_org`
 * semeia um funil de e-commerce ("Carrinho abandonado") em toda org nova, e é
 * justamente isso que uma clínica não consegue usar — repetir o erro no funil
 * criado à mão seria absurdo. Tudo aqui é renomeável em Configurações › Funis.
 */
export const ETAPAS_INICIAIS: ReadonlyArray<{
  name: string;
  slug: string;
  is_won: boolean;
  is_lost: boolean;
}> = [
  { name: "Novo", slug: "novo", is_won: false, is_lost: false },
  { name: "Em andamento", slug: "em_andamento", is_won: false, is_lost: false },
  { name: "Ganho", slug: "ganho", is_won: true, is_lost: false },
  { name: "Perdido", slug: "perdido", is_won: false, is_lost: true },
];

/**
 * Posição de um funil entre dois vizinhos (`null` = ponta da lista).
 *
 * Reexportado do mesmo motor do board e das etapas: uma segunda conta de posição
 * divergiria da deles no primeiro ajuste.
 */
export { midpoint as posicaoEntre } from "@/lib/kanban/fractional-indexing";
