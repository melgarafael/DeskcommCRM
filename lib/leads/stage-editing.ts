import { rotuloDoPasso, type EtapaDoMapa } from "@/lib/leads/agent-mapping";

/**
 * As regras da edição das etapas do funil, sem tocar no banco.
 *
 * Hoje nenhuma tela CRIA, RENOMEIA OU ARQUIVA etapa (a de mapeamento do
 * assistente escreve `agent_stage_hint`, e é o único outro escritor): o gatilho
 * `trg_seed_default_pipeline_for_org` semeia um funil de e-commerce em toda
 * organização criada, então uma clínica abre o sistema e vê "Carrinho
 * abandonado" sem ter como corrigir. Este arquivo é a camada pura que sustenta
 * a tela que resolve isso.
 *
 * ⚠️ POR QUE VALIDAR SE O BANCO JÁ RECUSA. O CHECK e os índices únicos são a
 * rede de segurança, não a primeira linha: `23505 uniq_crm_stages_pipeline_won`
 * chega ao dono da clínica como um texto que não ensina nada e não diz QUAL
 * etapa está errada. As mensagens daqui vão direto para a tela — por isso citam
 * o NOME da etapa, nunca o id nem o nome da constraint.
 *
 * ⚠️ O `slug` NÃO MUDA AO RENOMEAR. Ele é chave técnica sob
 * `uniq_crm_stages_pipeline_slug`; trocá-lo a cada edição de texto forçaria
 * tratar colisão toda vez e quebraria qualquer referência externa. O nome é o
 * que o usuário vê; o slug nasce com a etapa e morre com ela — por isso
 * `slugDeNome` só é chamado na CRIAÇÃO.
 *
 * ⚠️ ARQUIVAR, NÃO APAGAR. `crm_leads_stage_id_fkey` é `ON DELETE RESTRICT`:
 * etapa com negócio não pode ser apagada. Por isso a operação é arquivar, e por
 * isso arquivar precisa de destino para os negócios.
 */

/** O que a tela sabe de cada etapa ao editá-la. Inclui as arquivadas — quem filtra é este módulo. */
export interface EtapaEditavel extends EtapaDoMapa {
  slug: string;
  position: number;
  is_archived: boolean;
}

export type Resultado = { ok: true } | { ok: false; erro: string };

/**
 * A recusa do arquivamento, com o único caso que a TELA precisa distinguir.
 *
 * ⚠️ `precisaDestino` NÃO É REDUNDÂNCIA COM A MENSAGEM. A tela substitui esta
 * recusa por uma pergunta ("para onde vão os N negócios?") em vez de mostrá-la —
 * e decidir isso re-derivando o motivo do lado de lá (por "tem negócio e não é
 * de ganho/perda") funciona hoje por coincidência: qualquer recusa NOVA sobre
 * uma etapa comum com negócios passaria a ser engolida pela pergunta, e o
 * usuário gastaria um passo antes de ver o motivo real. Quem sabe qual regra
 * disparou é quem a aplicou.
 */
export type ResultadoDeArquivamento =
  | { ok: true }
  | { ok: false; erro: string; precisaDestino?: true };

/** Só as etapas que disputam nome, marcação e slug — os índices parciais ignoram arquivadas. */
function ativas(etapas: EtapaEditavel[]): EtapaEditavel[] {
  return etapas.filter((e) => !e.is_archived);
}

/**
 * Minúsculas, sem acento e sem espaço sobrando — o que o usuário lê como "o mesmo nome".
 *
 * ⚠️ DOBRAR ACENTO É DECISÃO DE PRODUTO, não detalhe técnico: quem digita
 * "Pos venda" com a etapa "Pós-venda" na tela criou uma duplicata que ele vai
 * ler como a mesma coluna, e ninguém explica ao dono da clínica por que o
 * quadro tem duas. Mesma razão para colapsar espaço interno.
 */
export function chaveDeNome(nome: string): string {
  return nome
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/**
 * Recusa o nome que o usuário leria como duplicado.
 *
 * `etapaId` é a etapa sendo renomeada (ou `null` na criação): sem isso,
 * renomear "Proposta" para "Proposta" colidiria consigo mesma.
 */
export function validarNomeDeEtapa(
  nome: string,
  etapas: EtapaEditavel[],
  etapaId: string | null,
): Resultado {
  if (!nome.trim()) {
    return { ok: false, erro: "Dê um nome à etapa — é o que aparece no topo da coluna." };
  }

  const chave = chaveDeNome(nome);
  // Arquivadas não entram: recusar por causa de uma etapa que sumiu do quadro
  // seria um erro sem saída — o usuário não consegue nem ver o que colidiu.
  const colisao = ativas(etapas).find((e) => e.id !== etapaId && chaveDeNome(e.name) === chave);
  if (colisao) {
    return {
      ok: false,
      erro: `Já existe uma etapa chamada «${colisao.name}» neste funil. Escolha outro nome.`,
    };
  }

  return { ok: true };
}

// `crm_stages_slug_format`: ^[a-z0-9_-]{2,40}$. Um caractere já viola.
const SLUG_MIN = 2;
const SLUG_MAX = 40;

/**
 * Slug técnico a partir do nome, só na criação da etapa.
 *
 * `slugsExistentes` são os slugs do funil (INCLUSIVE os das arquivadas:
 * `uniq_crm_stages_pipeline_slug` não é parcial, arquivada continua ocupando).
 *
 * `raizPadrao` é a saída de emergência quando o nome não produz slug válido
 * (emoji, uma letra só). `lib/pipelines/pipeline-editing.ts` reusa esta conta
 * para os FUNIS — o formato do slug é o mesmo nas duas tabelas, e uma segunda
 * cópia divergiria no primeiro ajuste — passando `"funil"`, senão um funil
 * chamado só de emoji nasceria com o slug `etapa`.
 */
export function slugDeNome(
  nome: string,
  slugsExistentes: string[] = [],
  raizPadrao = "etapa",
): string {
  const base = nome
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, SLUG_MAX)
    .replace(/^-+|-+$/g, "");

  // Nome só de emoji, ou de uma letra só, não vira slug válido — e slug vazio
  // violaria o formato e o índice único de uma vez.
  const raiz = base.length >= SLUG_MIN ? base : raizPadrao;

  const ocupados = new Set(slugsExistentes);
  if (!ocupados.has(raiz)) return raiz;

  for (let n = 2; ; n++) {
    const sufixo = `-${n}`;
    const candidato = raiz.slice(0, SLUG_MAX - sufixo.length) + sufixo;
    if (!ocupados.has(candidato)) return candidato;
  }
}

/** Só ganho e perda são marcação; o resto do funil é ordem e nome. */
export interface Marcacao {
  is_won?: boolean;
  is_lost?: boolean;
}

const CAMPO_DO_PASSO = { won: "is_won", lost: "is_lost" } as const;
type PassoDeDesfecho = keyof typeof CAMPO_DO_PASSO;

/**
 * Recusa a marcação que o banco recusaria, em português e citando a etapa.
 *
 * Espelha três coisas do schema: `crm_stages_won_lost_mutex`, o CHECK
 * `crm_stages_hint_coerente_com_won_lost` (nos DOIS sentidos) e a existência de
 * um lugar de ganho por funil.
 *
 * ⚠️ MOVER a marcação é permitido; DESMARCAR sem substituta, não. São coisas
 * diferentes: mover relocaliza o desfecho (e `updatesDeMarcacao` faz o passo do
 * assistente acompanhar), enquanto desmarcar deixaria o funil sem onde fechar
 * negócio — `/leads/[id]/win` passa a responder 422 `pipeline_no_won_stage`.
 *
 * ⚠️ A GUARDA OLHA `is_won`/`is_lost`, NÃO O HINT. O gatilho
 * `fn_seed_default_pipeline_for_org` (baseline.sql:707) semeia "Pago" com
 * `is_won=true, agent_stage_hint=null` — o backfill da 0084 rodou uma vez, sobre
 * o que já existia. Chavear no hint deixaria a instalação FRESCA, que é o
 * cenário deste arquivo, sem proteção nenhuma. E não há o que perder: o CHECK já
 * garante que hint='won' só existe em etapa com `is_won`.
 */
export function validarMarcacao(
  etapas: EtapaEditavel[],
  etapaId: string,
  marcacao: Marcacao,
): Resultado {
  const etapa = etapas.find((e) => e.id === etapaId);
  if (!etapa) {
    return { ok: false, erro: "Essa etapa não faz parte deste funil. Recarregue a página e tente de novo." };
  }

  const desejado: Record<PassoDeDesfecho, boolean> = {
    won: marcacao.is_won ?? etapa.is_won,
    lost: marcacao.is_lost ?? etapa.is_lost,
  };

  if (desejado.won && desejado.lost) {
    return {
      ok: false,
      erro: `A etapa «${etapa.name}» não pode ser de ganho e de perda ao mesmo tempo — escolha uma.`,
    };
  }

  for (const passo of ["won", "lost"] as const) {
    const campo = CAMPO_DO_PASSO[passo];
    const desfecho = passo === "won" ? "de ganho" : "de perda";

    if (!desejado[passo] && etapa[campo]) {
      return {
        ok: false,
        erro:
          `A etapa «${etapa.name}» é a etapa ${desfecho} deste funil e o funil precisa de uma. ` +
          `Marque OUTRA etapa como ${desfecho} — a marcação se muda, não se apaga.`,
      };
    }

    if (desejado[passo] && etapa.agent_stage_hint && etapa.agent_stage_hint !== passo) {
      return {
        ok: false,
        erro:
          `A etapa «${etapa.name}» representa «${rotuloDoPasso(etapa.agent_stage_hint)}» no atendimento ` +
          `do assistente, então não pode ser a etapa ${desfecho}. Mude o mapeamento do assistente antes.`,
      };
    }
  }

  return { ok: true };
}

export interface PatchDeMarcacao {
  is_won?: boolean;
  is_lost?: boolean;
  agent_stage_hint?: string | null;
}

export interface UpdateDeMarcacao {
  stageId: string;
  patch: PatchDeMarcacao;
}

/**
 * A marcação desejada traduzida nos UPDATEs, NA ORDEM EM QUE PRECISAM SAIR.
 *
 * Chame DEPOIS de `validarMarcacao` — aqui não há veredito, só diferença.
 *
 * ⚠️ A DESMARCAÇÃO DA ANTIGA VEM PRIMEIRO, e não é estética:
 * `uniq_crm_stages_pipeline_won` é imediato (não deferível), então marcar a nova
 * antes de liberar a antiga é um 23505 cru na cara do usuário.
 *
 * ⚠️ O PASSO DO ASSISTENTE ACOMPANHA A MARCAÇÃO. A etapa que perde o `is_won`
 * não pode continuar declarando `agent_stage_hint='won'` (CHECK
 * `crm_stages_hint_coerente_com_won_lost`), e apagar o hint sem repassá-lo
 * desligaria o agente em silêncio — o tenant só descobriria meses depois,
 * quando um negócio fechado parasse de mudar de coluna.
 */
export function updatesDeMarcacao(
  etapas: EtapaEditavel[],
  etapaId: string,
  marcacao: Marcacao,
): UpdateDeMarcacao[] {
  const alvo = etapas.find((e) => e.id === etapaId);
  if (!alvo) return [];

  const liberacoes: UpdateDeMarcacao[] = [];
  const patchDoAlvo: PatchDeMarcacao = {};

  for (const passo of ["won", "lost"] as const) {
    const campo = CAMPO_DO_PASSO[passo];
    const desejado = marcacao[campo];
    if (desejado === undefined || desejado === alvo[campo]) continue;

    patchDoAlvo[campo] = desejado;

    if (!desejado) {
      if (alvo.agent_stage_hint === passo) patchDoAlvo.agent_stage_hint = null;
      continue;
    }

    // Arquivada não disputa: os índices únicos de ganho/perda são parciais.
    const anterior = ativas(etapas).find((e) => e.id !== alvo.id && e[campo]);
    if (!anterior) continue;

    const patch: PatchDeMarcacao = { [campo]: false };
    if (anterior.agent_stage_hint === passo) {
      patch.agent_stage_hint = null;
      patchDoAlvo.agent_stage_hint = passo;
    }
    liberacoes.push({ stageId: anterior.id, patch });
  }

  if (Object.keys(patchDoAlvo).length === 0) return liberacoes;
  return [...liberacoes, { stageId: alvo.id, patch: patchDoAlvo }];
}

/**
 * Posição de uma etapa entre duas vizinhas (`null` = ponta da lista).
 *
 * Reexportado de propósito: a tela do funil importa deste módulo, e uma segunda
 * conta de posição divergiria da do board no primeiro ajuste.
 */
export { midpoint as posicaoEntre } from "@/lib/kanban/fractional-indexing";

export interface PedidoDeArquivamento {
  /** Quantos negócios estão na etapa AGORA. */
  negocios: number;
  /** Para onde eles vão. `null` só é aceito com a etapa vazia. */
  destinoId: string | null;
}

/**
 * Recusa o arquivamento que deixaria negócio órfão ou funil sem coluna.
 *
 * Arquivar (e não apagar) é o que `crm_leads_stage_id_fkey ON DELETE RESTRICT`
 * impõe: o histórico dos negócios continua apontando para a etapa.
 *
 * ⚠️ A ETAPA DE GANHO/PERDA NÃO PODE SER ARQUIVADA. `/leads/[id]/win` procura a
 * etapa por `.eq("is_won", true)` SEM filtrar arquivada: com a de ganho
 * arquivada, o negócio fechado É MOVIDO para uma coluna que sumiu do quadro.
 * Some em silêncio, que é pior do que recusar a operação aqui.
 */
export function validarArquivamento(
  etapas: EtapaEditavel[],
  etapaId: string,
  { negocios, destinoId }: PedidoDeArquivamento,
): ResultadoDeArquivamento {
  const etapa = etapas.find((e) => e.id === etapaId);
  if (!etapa) {
    return { ok: false, erro: "Essa etapa não faz parte deste funil. Recarregue a página e tente de novo." };
  }

  const restantes = ativas(etapas).filter((e) => e.id !== etapaId);
  if (restantes.length === 0) {
    return {
      ok: false,
      erro:
        `«${etapa.name}» é a única etapa deste funil. Um funil sem etapa nenhuma some do quadro e não ` +
        `recebe negócio novo — crie outra etapa antes de arquivar esta.`,
    };
  }

  for (const passo of ["won", "lost"] as const) {
    if (etapa[CAMPO_DO_PASSO[passo]]) {
      const desfecho = passo === "won" ? "de ganho" : "de perda";
      return {
        ok: false,
        erro:
          `«${etapa.name}» é a etapa ${desfecho} deste funil. Marque OUTRA etapa como ${desfecho} antes ` +
          `de arquivar esta — senão os negócios continuariam indo parar numa coluna fora do quadro.`,
      };
    }
  }

  if (destinoId === etapaId) {
    return {
      ok: false,
      erro: `Os negócios de «${etapa.name}» precisam ir para outra etapa, não para ela mesma.`,
    };
  }

  if (negocios > 0) {
    if (!destinoId) {
      return {
        ok: false,
        erro:
          `A etapa «${etapa.name}» tem ${negocios} ${negocios === 1 ? "negócio" : "negócios"}. ` +
          `Escolha para qual etapa eles vão antes de arquivá-la.`,
        // A ÚNICA recusa que a tela troca por uma pergunta em vez de mostrar.
        precisaDestino: true,
      };
    }
    const destino = restantes.find((e) => e.id === destinoId);
    if (!destino) {
      return {
        ok: false,
        erro: `A etapa escolhida para receber os negócios de «${etapa.name}» não está mais no funil. Recarregue a página.`,
      };
    }

    // ⚠️ O DESTINO NÃO PODE SER A ETAPA DE GANHO NEM A DE PERDA, e os dois lados
    // são ruins de um jeito diferente. `fn_crm_lead_close_on_stage` fecha o
    // negócio pelo estágio: mandar N negócios para a de GANHO os marca
    // `status='won'` com `closed_at=now()` — receita mexida por uma ação de
    // configuração, em silêncio. Para a de PERDA, `fn_validate_lost_reason_required`
    // levanta `22023` e a tela recebe o texto do Postgres colado numa frase em
    // português. Arquivar uma etapa é organizar o quadro, não fechar negócio.
    for (const passo of ["won", "lost"] as const) {
      if (destino[CAMPO_DO_PASSO[passo]]) {
        const desfecho = passo === "won" ? "de ganho" : "de perda";
        return {
          ok: false,
          erro:
            `«${destino.name}» é a etapa ${desfecho} deste funil: mandar os negócios de «${etapa.name}» ` +
            `para lá os daria por encerrados. Escolha uma etapa em aberto.`,
        };
      }
    }
  }

  return { ok: true };
}
