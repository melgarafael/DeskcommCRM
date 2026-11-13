import { comercialExigeHumano } from '@/lib/escalacao/assunto-comercial';
/** Preview is an execution policy of the real turn, never a simulated queue job. */
import type pg from 'pg';
import { hasOpenCaseForContact } from './human-cases';
import type { ToolSet } from '../edge/llm/run-model-call';
import type { LeadContext, LeadContextResult } from '../edge/crm/get-lead-context';
import type { PublishedAgentConfig } from './agent-config';
import type { LeadCheckpointRow } from './inbound-turn';
import type { FerramentaNoTraco } from './traco-do-turno';
import { ferramentasDeAgendaDoAgente, temFerramentaDeAgenda } from './inbound-turn';
import {
  BEFORE_SEND_GATES,
  evaluateBeforeSend,
  factualClaimGate,
  type Gate,
  type GateContext,
  type GateTraceEntry,
  loadChannelProvider,
  pacingGate,
} from '../guardrails/before-send';
import type { ConferenciaDeFato } from '../guardrails/factual-claim';
import { loadChannelKnobs, loadPacingState } from '../pacing/store';
import { PACING_DEFAULTS } from '../pacing/defaults';
import { SPINNING_DEFAULTS } from '../spinning/defaults';
import { loadRecentCopies, loadSpinningKnobs } from '../spinning/store';
import { loadPromiseTable } from '../guardrails/promise/table';
import { camadaLigada, lerCamadasDaOrg } from '../guardrails/camadas-da-org';
import { loadDisclosureTemplate, countPriorAcceptedSends } from '../guardrails/disclosure/template';
import { DEFAULT_CHANNEL_PROVIDER } from '@/lib/channels/capabilities';
import { getToolByName } from '@/lib/mcp/tools';
import { ehLeituraRemota } from '@/lib/mcp/servidor-externo/leitura-remota';
import type { Logger } from '../obs/logger';
import type { Citation } from '@/lib/ai/citations/types';
import type { FotosPreparadas, MidiaPreparada } from './fotos-do-produto';
import type { AnexoDeMaterial, MaterialPreparado } from './materiais-da-empresa';
import { formatoDeImagemPorUrl } from './imagem-por-url';
import { countPayloadTokens } from '@/lib/ai/estimativa-de-tokens';
import { renderNotesIndexBlock } from './lead-notes';

export interface TurnPreview {
  kind: 'sandbox' | 'assisted';
  organizationId: string;
  runId: string;
  agent: PublishedAgentConfig;
  context: Extract<LeadContextResult, { ok: true }>;
  previous?: LeadCheckpointRow | null;
  /** `id` endereça a nota no modo índice (`get_lead_note`) — ver `blocoDeNotasDaPrevia`. */
  notes?: Array<{ id: string; headline: string; body: string }>;
  feedback?: string;
  /** Null means a scenario, never a synthetic identifier passed to SQL. */
  contactId: string | null;
  channelId: string | null;
  /**
   * Etiquetas SIMULADAS da conversa (spec 27, fatia 3): o Testar as passa ao matcher de skills
   * no lugar das etiquetas reais, que a prévia não tem. Ausente = nenhuma.
   */
  tags?: string[];
  gateContext?: GateContext;
  result: PreviewResult;
}
/**
 * O que o dry-run apurou sobre o MATERIAL que a resposta usaria (#4129).
 *
 * `anexo` é o que sairia no envio real; `falha` presente significa teste
 * VERMELHO — o dry-run não degrada para só texto nem aprova com o arquivo
 * pendente, a mesma régua do #2490 para as fotos do produto.
 */
export interface MaterialPreparadoNoTeste {
  materialId: string;
  /** Nome do material, quando o preparo chegou a resolvê-lo. */
  nome: string | null;
  anexo: AnexoDeMaterial | null;
  falha?: { code: string; message: string };
}

export interface PreviewResult {
  checkpoint?: unknown;
  candidates: Array<{ body: string; citations: Citation[]; trace: GateTraceEntry[] }>;
  proposals: Array<{ tool: string; arguments: unknown }>;
  /**
   * #4424 — as ferramentas que o turno REALMENTE chamou (as de leitura rodam de
   * verdade na prévia). É a mesma lista que o traço do turno grava; ela passou a
   * viajar na resposta para o Testar mostrar, turno a turno, o que a IA usou —
   * antes quem lia o painel só via as ações PROPOSTAS.
   *
   * Opcional: `reply-drafts` não a preenche nem a lê.
   */
  ferramentas?: FerramentaNoTraco[];
  impediments: Array<{ code: string; message: string }>;
  /**
   * O que NÃO impediu o candidato, mas o operador precisa ver sobre o ENVIO real:
   * um gate que o barraria agora, ou uma mídia que não sairia (produto sem fotos,
   * #2490). O aviso de gate só o sandbox escreve (ver `gatesDoSandbox`) — o rascunho
   * assistido trata o mesmo veto como impedimento; o de produto sem fotos
   * (`midia_sem_fotos`) sai nos dois.
   */
  warnings: Array<{ code: string; message: string }>;
  restrictions: string[];
  /**
   * A mídia que a resposta USARIA, preparada pelo MESMO caminho do envio real
   * (#2490): produto resolvido no catálogo, fotos preparadas e anexos previstos.
   * Falha aqui vira `falha` no registro E impedimento no teste — nunca candidato.
   */
  midia: MidiaPreparada[];
  /**
   * O material da empresa que a resposta USARIA (#4129), preparado pelo MESMO
   * `prepararMaterialDaEmpresa` do envio real — mesma query, mesmos freios,
   * mesma cópia. `anexo` é o que sairia; `falha` presente reprova o teste, como
   * no #2490: mídia que ninguém preparou não atravessa o dry-run como aprovada.
   */
  materiais: MaterialPreparadoNoTeste[];
}
/**
 * Teto do bloco de notas INLINE da prévia (headline + corpo de cada nota).
 *
 * Abaixo dele a prévia segue como sempre foi: os corpos vão inteiros no prompt,
 * byte a byte a string de antes. Acima — só no caso extremo, ~14 mil caracteres
 * de notas — ela passa a usar o índice com id, a mesma receita do turno real
 * (`renderNotesIndexBlock`), e o `get_lead_note` busca o corpo pelo id. Sem o
 * teto, 20 notas de 4.000 caracteres entravam inteiras em todo passo.
 */
// ponytail: teto fixo, ~16x o maior caso medido (872 caracteres); vira knob se algum dono pedir
export const PREVIEW_NOTES_INLINE_MAX_TOKENS = 4_000;

export function blocoDeNotasDaPrevia(
  notes: NonNullable<TurnPreview['notes']>,
  indexBudget: number,
): { bloco: string; inline: boolean } {
  const inline = notes.map((n) => n.headline + ': ' + n.body).join('\n');
  if (countPayloadTokens(inline) <= PREVIEW_NOTES_INLINE_MAX_TOKENS) return { bloco: inline, inline: true };
  return { bloco: renderNotesIndexBlock(notes, indexBudget), inline: false };
}

/**
 * O `get_lead_note` da prévia. No modo inline a resposta é a de sempre (todas as
 * notas, sem o id); no modo índice ela tem o formato da ferramenta real — UM corpo,
 * pelo id que o modelo leu no índice.
 */
export function lerNotaDaPrevia(
  notes: NonNullable<TurnPreview['notes']>,
  inline: boolean,
  /** Os argumentos crus da chamada — `{ note_id }`, vindos do modelo. */
  args: unknown,
):
  | { ok: true; notes: Array<{ headline: string; body: string }> }
  | { ok: true; note_id: string; body: string }
  | { ok: false; error: { code: 'note_not_found'; message: string } } {
  if (inline) return { ok: true, notes: notes.map(({ headline, body }) => ({ headline, body })) };
  const noteId = args && typeof args === 'object' && 'note_id' in args ? args.note_id : undefined;
  const id = typeof noteId === 'string' ? noteId.trim() : '';
  const nota = notes.find((n) => n.id === id);
  return nota
    ? { ok: true, note_id: nota.id, body: nota.body }
    : {
        ok: false,
        error: {
          code: 'note_not_found',
          message: 'não há nota com esse id na memória deste lead — confira o id no índice de memória.',
        },
      };
}

export function newPreviewResult(): PreviewResult {
  return {
    candidates: [],
    proposals: [],
    impediments: [],
    warnings: [],
    midia: [],
    materiais: [],
    restrictions: [
      'preview_no_client_effects',
      'writes_require_separate_authorization',
      'send_revalidates_live_state',
    ],
  };
}

export async function previewGateContext(
  db: pg.Pool,
  p: TurnPreview,
  log: Logger,
  now: Date,
): Promise<GateContext> {
  if (p.gateContext) return { ...p.gateContext, now };
  const org = p.organizationId,
    channel = p.channelId;
  const cfg = channel
    ? await loadChannelKnobs(db, org, channel, log)
    : { knobs: PACING_DEFAULTS, numberActivatedAt: null };
  const spinning = channel ? await loadSpinningKnobs(db, org, channel, log) : SPINNING_DEFAULTS;
  const promise = await loadPromiseTable(db, org),
    disclosure = await loadDisclosureTemplate(db, org);
  const first = p.contactId ? (await countPriorAcceptedSends(db, org, p.contactId)) === 0 : true;
  let lastInbound: Date | null = null;
  if (p.contactId && channel) {
    const { rows } = await db.query<{ last_inbound_at: Date | null }>(
      'select last_inbound_at from conversations where organization_id=$1 and id=$2 and contact_id=$3 and channel_session_id=$4',
      [org, p.context.context.conversation_id, p.contactId, channel],
    );
    lastInbound = rows[0]?.last_inbound_at ?? null;
  } else {
    const last = p.context.context.messages.filter((m) => m.direction === 'inbound').at(-1);
    lastInbound = last ? new Date(last.sent_at) : null;
    p.result.restrictions.push('contact_state_is_scenario');
  }
  return {
    now,
    body: '',
    optedOut: p.context.context.contact.is_blocked,
    provider: channel ? await loadChannelProvider(db, org, channel) : DEFAULT_CHANNEL_PROVIDER,
    messagingWindow: { lastInboundAt: lastInbound },
    pacing: {
      knobs: cfg.knobs,
      // A prévia propõe a RESPOSTA a uma mensagem recebida: vale a janela
      // `resposta_*` (0495), a mesma que `approved-reply.ts` usa ao enviar o
      // rascunho aprovado (#1984). Sem isto, o rascunho da prévia seria vetado
      // pelo `outside_window` da janela de DISPARO (7h-22h) em vez da de resposta.
      resposta: true,
      state: channel
        ? await loadPacingState(db, org, channel, {
            now,
            timezone: cfg.knobs.timezone,
            numberActivatedAt: cfg.numberActivatedAt,
          })
        : { lastSentAt: null, sentToday: 0, numberActivatedAt: null },
      crmDailyLimit: null,
    },
    spinning: {
      knobs: spinning,
      window: channel ? await loadRecentCopies(db, org, channel, spinning.windowSize) : [],
    },
    promise: { table: promise?.table ?? null },
    semanticPromise: null,
    disclosure: { template: disclosure?.body ?? null, isFirstOutbound: first, mode: 'inject' },
    lgpd: { ...p.context.lgpd, isFirstOutbound: first },
    casesEnabled: p.agent.casesEnabled,
    hasOpenCase:
      p.contactId && p.agent.casesEnabled
        ? await hasOpenCaseForContact(db, org, p.context.context.conversation_id!)
        : false,
    openedCaseThisTurn: false,
    humanPromiseExtraTargets: p.agent.handoffKeywords,
    // A MESMA condição do turno real (`temFerramentaDeAgenda`): a prévia existe
    // para mostrar o que vai acontecer, e um gate que arma diferente aqui faz
    // quem afina o prompt testar contra outro sistema.
    agenda: {
      active: temFerramentaDeAgenda(p.agent.toolIds),
      ferramentas: ferramentasDeAgendaDoAgente(p.agent.toolIds),
      toolCalledThisTurn: false,
    },
    internalVocabularyEnforced: true,
    // A MESMA decisão do turno real: a camada de afirmação clínica é da organização.
    // Um Testar que arma diferente da produção faz quem afina o prompt testar contra
    // outro sistema — o mesmo motivo do `agenda` logo acima.
    clinicalClaimEnforced: camadaLigada((await lerCamadasDaOrg(db, org)).afirmacao_clinica, false),
    commercialRestrictionEnforced: await comercialExigeHumano(db, org),
  };
}
export const SCENARIO_READS = new Set([
  'crm_list_pipelines',
  'crm_list_stages',
  'crm_list_event_types',
  'crm_find_free_slots',
  'crm_describe_external_data',
  'crm_query_external_data',
  // Catálogo e acervo são material da ORGANIZAÇÃO, não de um contato: sem eles o
  // Testar (que roda sem contato) não responde preço nem agenda e o agente cai
  // em "vou confirmar e te retorno". Dado de contato/lead continua fora daqui.
  'crm_search_products',
  'crm_search_knowledge',
]);
/**
 * A cadeia do Testar (sandbox): a de produção, com DOIS vetos rebaixados a aviso.
 *
 * Fora da janela de envio, o `pacingGate` impede que a resposta do modelo
 * apareça como candidato de teste. Janela, aquecimento e limite diário protegem
 * o envio real; o sandbox não envia mensagens. Rebaixar somente esse veto a aviso
 * permite inspecionar o candidato e executar os demais gates de conteúdo.
 *
 * #2923: a conferência de fato (`factual_claim`) segue o mesmo raciocínio AQUI.
 * Ela agora roda também na prévia — é na prévia do modo assistido que o veredito
 * vira impedimento visível para quem revisa —, e no Teste não há cliente nem
 * rascunho a caminho: `contradiz`/`nao_esta_na_base` viram AVISO, como o veto de
 * pacing, em vez de esconder a resposta que o operador está testando.
 *
 * Só o pacing e a conferência de fato mudam, e só aqui. Opt-out, LGPD e os gates
 * de conteúdo continuam vetando; o rascunho assistido (`assisted`, contato real)
 * e a produção seguem com `BEFORE_SEND_GATES` intacta. O veto vira linha
 * `skipped: 'sandbox_send_embargo'` no trace e um aviso explícito no resultado —
 * nunca um `pass` silencioso.
 *
 * A comparação é INLINE, e não um `Set` de módulo: há testes que substituem este
 * módulo inteiro por um dublê (`vi.mock(..., () => ({ runBeforeSend }))`), e ler
 * `pacingGate.name` no topo do arquivo derrubaria todos eles no import. Aqui a
 * leitura acontece só quando o Teste de fato avalia a cadeia.
 */
function gatesDoSandbox(avisos: Array<{ code: string; message: string }>): readonly Gate[] {
  return BEFORE_SEND_GATES.map((gate) =>
    gate.name !== pacingGate.name && gate.name !== factualClaimGate.name
      ? gate
      : {
          name: gate.name,
          evaluate: (ctx: GateContext) => {
            const verdict = gate.evaluate(ctx);
            if (verdict.pass) return verdict;
            avisos.push({
              code: verdict.code,
              message:
                `Em produção esta resposta não sairia agora (${verdict.reason}). ` +
                'O teste mostra a resposta mesmo assim; nenhuma mensagem foi enviada.',
            });
            return { pass: true, skipped: 'sandbox_send_embargo' as const };
          },
        },
  );
}
/**
 * A MESMA preparação de mídia do envio real, dentro do dry-run (#2490).
 *
 * `preparar` é injetado por quem monta a prévia e resolve a `prepararFotosDoProduto`
 * do caminho de produção — mesma query no catálogo, mesma cópia. Aqui só se
 * traduz o desfecho para o VOCABULÁRIO do teste:
 *
 * - código sem produto, ou foto que não copiou → `falha` (o teste fica VERMELHO;
 *   o envio real degrada para só texto, o teste não pode fingir que passou);
 * - produto sem fotos → conta zerada, sem `falha`: nada a enviar, dito claramente;
 * - sem `preparar` injetado → também `falha`: mídia que ninguém preparou não
 *   pode atravessar o teste como se tivesse sido validada.
 */
async function prepararMidiaNoDryRun(
  preparar: ((codigo: string) => Promise<FotosPreparadas>) | undefined,
  codigo: string,
): Promise<MidiaPreparada> {
  const semProduto = (falha: { code: string; message: string }): MidiaPreparada => ({
    codigo,
    produtoResolvido: false,
    fotosCadastradas: 0,
    fotosPreparadas: 0,
    anexos: [],
    falha,
  });
  if (!preparar)
    return semProduto({
      code: 'midia_nao_preparada',
      message:
        'A mídia desta resposta não foi preparada no teste — não há como afirmar que as fotos ' +
        'saíriam no envio real. Corrija a preparação e execute o teste de novo.',
    });
  const preparadas = await preparar(codigo);
  if (!preparadas.ok) return semProduto({ code: preparadas.code, message: preparadas.message });
  const registro: MidiaPreparada = {
    codigo,
    produtoResolvido: true,
    fotosCadastradas: preparadas.tinha,
    fotosPreparadas: preparadas.fotos.length,
    anexos: [...preparadas.fotos],
  };
  const faltaram = preparadas.tinha - preparadas.fotos.length;
  if (faltaram > 0)
    registro.falha = {
      code: 'midia_nao_preparada',
      message:
        `${faltaram} foto(s) do produto ${JSON.stringify(codigo)} não puderam ser preparadas no ` +
        'teste. Em produção o texto sairia sem elas; aqui o teste falha de propósito, para o ' +
        'problema não chegar só no atendimento real.',
    };
  return registro;
}
/** Unknown tools fail closed. A write proposal never calls its original execute. */
export function applyPreviewPolicy(
  tools: ToolSet,
  p: TurnPreview,
  ctx: GateContext,
  citations: () => Citation[],
  semanticClassifier?: (body: string) => Promise<NonNullable<GateContext['semanticPromise']>>,
  liveContext?: () => Partial<GateContext>,
  /**
   * #2490 — a `prepararFotosDoProduto` do caminho de produção, injetada pelo
   * turno que tem banco e Storage. Sem ela o `produto_codigo` NÃO passa: o
   * teste falha a mídia em vez de aprovar texto com foto pendente.
   */
  prepararMidia?: (codigo: string) => Promise<FotosPreparadas>,
  /**
   * #2923 — a MESMA conferência de fato do turno automático
   * (`criarConferidorDeAfirmacoes`), com as evidências consultadas NESTE turno
   * da prévia. Sem ela o `evaluateBeforeSend` da prévia recebia o contexto sem
   * `factualClaim`, e a camada 6.3 nem era avaliada: o rascunho do modo
   * assistido — justamente o que alguém revisa antes de o cliente receber — saía
   * com a afirmação de fato sem conferência e sem observação para calibrar.
   */
  conferirAfirmacoes?: (candidata: string) => Promise<ConferenciaDeFato>,
  /** A procedência da `imagem_url` no turno (`criarProcedenciaDeImagens().viu`), a mesma do envio real. */
  imagemVistaNoTurno?: (url: string) => boolean,
  /**
   * #4129 — a `prepararMaterialDaEmpresa` do caminho de produção, injetada pelo
   * turno que tem banco e Storage. Sem ela o `material_id` NÃO passa: o teste
   * falha a mídia em vez de aprovar texto com o arquivo pendente.
   *
   * Fica por ÚLTIMO (e não junto do `prepararMidia`): os slots acima são
   * chamados por POSIÇÃO, e enfiar este no meio deles deslocaria o conferidor e
   * a procedência da `imagem_url` de quem já chamava assim.
   */
  prepararMaterial?: (materialId: string) => Promise<MaterialPreparado>,
): ToolSet {
  return Object.fromEntries(
    Object.entries(tools).map(([name, definition]) => {
      const nativeRead = [
        'get_lead_context',
        'get_lead_note',
        'search_knowledge',
        // #4572 — o irmão do `search_knowledge` no modo `leitura_direta`: só
        // leitura, escopado pela organização no closure. Fora daqui ele virava
        // `unknown_preview_tool`, e o Testar dizia "preciso verificar" sobre o
        // que a produção lê e responde.
        'ler_documento',
        'read_skill_reference',
      ].includes(name);
      const catalog = getToolByName(name);
      if (
        nativeRead ||
        (catalog?.category === 'read' && (p.contactId !== null || SCENARIO_READS.has(name))) ||
        // #2147/#4317 — leitura de servidor MCP externo (da organização ou do
        // PRÓPRIO agente): só o objeto que `pickToolsFromMcp` marcou, com as
        // duas metades (marca do admin E `readOnlyHint` do servidor). Nome
        // igual ao catálogo nativo ou cópia do objeto continuam recusados.
        (!catalog && ehLeituraRemota(definition))
      )
        return [name, definition];
      return [
        name,
        {
          ...definition,
          execute: async (args: unknown) => {
            if (name === 'send_message') {
              const body =
                args && typeof args === 'object' && 'body' in args && typeof args.body === 'string'
                  ? args.body
                  : '';
              // Duas fotos na mesma mensagem não existem (Spec 25 R4): mesma recusa do envio
              // real, antes de qualquer preparo de mídia.
              const pediuFotoDoCatalogo =
                args &&
                typeof args === 'object' &&
                'produto_codigo' in args &&
                typeof args.produto_codigo === 'string' &&
                args.produto_codigo.trim() !== '';
              const pediuImagemPorUrl =
                args && typeof args === 'object' && 'imagem_url' in args && typeof args.imagem_url === 'string'
                  ? args.imagem_url.trim() !== ''
                  : false;
              if (pediuFotoDoCatalogo && pediuImagemPorUrl) {
                const message =
                  'Use imagem_url OU produto_codigo, não os dois na mesma mensagem. Mande de novo só com um deles.';
                p.result.impediments.push({ code: 'imagem_e_produto_juntos', message });
                return { ok: false, error: { code: 'imagem_e_produto_juntos', message } };
              }
              // #2490 — A MESMA preparação do envio real, e na MESMA ordem: o
              // `produto_codigo` que `crm_search_products` devolveu resolve o
              // produto no catálogo e prepara as fotos ANTES da cadeia (é o que
              // `inbound-turn.ts` faz no caminho de produção). Aqui o preparo é
              // o único efeito — nenhuma mensagem sai pelo canal de entrega e
              // nada é gravado em conversa nenhuma, como `preview_no_client_effects`
              // manda.
              const produtoCodigo =
                args && typeof args === 'object' && 'produto_codigo' in args
                  ? typeof args.produto_codigo === 'string'
                    ? args.produto_codigo
                    : undefined
                  : undefined;
              if (produtoCodigo !== undefined && produtoCodigo.trim() !== '') {
                const midia = await prepararMidiaNoDryRun(prepararMidia, produtoCodigo);
                p.result.midia.push(midia);
                // Falha de mídia NÃO vira candidato: sem degradar para só texto,
                // sem aprovar o teste com a foto pendente (issue #2490, item 6).
                if (midia.falha) {
                  p.result.impediments.push({ code: midia.falha.code, message: midia.falha.message });
                  return {
                    ok: false,
                    error: { code: midia.falha.code, message: midia.falha.message },
                  };
                }
                // Produto sem foto é desfecho LEGÍTIMO do envio real — não é
                // falha, mas o operador tem de ler que nenhuma imagem sairia.
                if (midia.fotosCadastradas === 0 && !p.result.warnings.some((w) => w.code === 'midia_sem_fotos'))
                  p.result.warnings.push({
                    code: 'midia_sem_fotos',
                    message:
                      `O produto ${JSON.stringify(midia.codigo)} não tem fotos cadastradas: ` +
                      'nenhuma imagem seria enviada no envio real — só o texto.',
                  });
              }
              const materialId =
                args && typeof args === 'object' && 'material_id' in args
                  ? typeof args.material_id === 'string'
                    ? args.material_id
                    : undefined
                  : undefined;
              if (
                materialId !== undefined &&
                materialId.trim() !== '' &&
                produtoCodigo !== undefined &&
                produtoCodigo.trim() !== ''
              ) {
                // A MESMA recusa do turno real: as duas listas competem pela
                // legenda, e o teste não pode aprovar o que a produção recusa.
                const falha = {
                  code: 'material_e_produto_juntos',
                  message:
                    'Escolha UM anexo: `material_id` (documento da empresa) OU `produto_codigo` (fotos do catálogo).',
                };
                p.result.impediments.push(falha);
                return { ok: false, error: falha };
              }
              if (materialId !== undefined && materialId.trim() !== '') {
                // #4129 — a MESMA `prepararMaterialDaEmpresa` do envio real: a
                // lista do agente, os freios de reenvio e a cópia para a pasta
                // `dry-run` da organização, como as fotos em #2490. Nada sai
                // pelo canal e nada é gravado em conversa nenhuma.
                const preparado = prepararMaterial
                  ? await prepararMaterial(materialId.trim())
                  : ({
                      ok: false as const,
                      code: 'material_nao_preparado',
                      message:
                        'A mídia desta resposta não foi preparada no teste — não há como afirmar ' +
                        'que o material sairia no envio real. Corrija a preparação e execute o teste de novo.',
                    } as const);
                if (!preparado.ok) {
                  p.result.materiais.push({
                    materialId: materialId.trim(),
                    nome: null,
                    anexo: null,
                    falha: { code: preparado.code, message: preparado.message },
                  });
                  p.result.impediments.push({ code: preparado.code, message: preparado.message });
                  return { ok: false, error: { code: preparado.code, message: preparado.message } };
                }
                p.result.materiais.push({
                  materialId: materialId.trim(),
                  nome: preparado.material.nome,
                  anexo: preparado.anexo,
                });
              }
              // Foto por URL (Spec 25 R4): na prévia NADA é buscado nem enviado, e a guarda de
              // rede (C6) não roda aqui — só o formato e a procedência são conferidos, sem rede.
              // Quem decide a foto de verdade é o envio real. O retorno diz o que sairia.
              const imagemUrl =
                args && typeof args === 'object' && 'imagem_url' in args && typeof args.imagem_url === 'string'
                  ? args.imagem_url.trim()
                  : '';
              let imagemPrevista: string | undefined;
              if (imagemUrl !== '') {
                const formato = formatoDeImagemPorUrl(imagemUrl);
                if (formato.ok && imagemVistaNoTurno && !imagemVistaNoTurno(imagemUrl)) {
                  imagemPrevista = 'recusada: url_fora_dos_resultados';
                  p.result.warnings.push({
                    code: 'imagem_recusada',
                    message:
                      'A imagem desta resposta seria recusada (url_fora_dos_resultados): o texto sairia sem foto.',
                  });
                } else if (formato.ok) {
                  imagemPrevista = 'formato_aceito';
                } else {
                  imagemPrevista = `recusada_pelo_formato: ${formato.motivo}`;
                  p.result.warnings.push({
                    code: 'imagem_recusada',
                    message:
                      `A imagem desta resposta seria recusada (${formato.motivo}): o texto sairia sem foto.`,
                  });
                }
              }
              const avisos: Array<{ code: string; message: string }> = [];
              // #2923 — as duas perguntas ao Jev da cadeia (promessa semântica,
              // F4-02, e conferência de fato, 6.3) saem juntas, como em
              // `runBeforeSend`: em série a prévia pagaria as duas idas-e-voltas
              // uma atrás da outra. A conferência é a MESMA do turno automático,
              // com as evidências consultadas NESTE turno — e é ela que grava a
              // observação com o rótulo do Jev (na prévia, com o par em aberto:
              // quem fecha é a resposta aprovada).
              const [semanticPromise, factualClaim] = await Promise.all([
                semanticClassifier ? semanticClassifier(body) : Promise.resolve(null),
                conferirAfirmacoes ? conferirAfirmacoes(body) : Promise.resolve(null),
              ]);
              const result = evaluateBeforeSend(
                {
                  ...ctx,
                  ...liveContext?.(),
                  body,
                  semanticPromise,
                  factualClaim,
                },
                p.kind === 'sandbox' ? gatesDoSandbox(avisos) : BEFORE_SEND_GATES,
              );
              if (result.veto) {
                p.result.impediments.push({ code: result.veto.code, message: result.veto.message });
                if (result.veto.code === 'commercial_requires_human' &&
                    !p.result.proposals.some((x) => x.tool === 'crm_request_human_handoff')) {
                  p.result.proposals.push({ tool: 'crm_request_human_handoff', arguments: {
                    reason: 'Valores e negociação: atendimento exclusivamente humano.',
                  } });
                }
                return {
                  ok: false,
                  error: { code: result.veto.code, message: result.veto.message },
                };
              }
              // O aviso acompanha um candidato; vetado por outro gate, o impedimento já diz.
              for (const aviso of avisos)
                if (!p.result.warnings.some((w) => w.code === aviso.code))
                  p.result.warnings.push(aviso);
              p.result.candidates.push({
                body: result.body,
                citations: citations(),
                trace: result.trace,
              });
              return {
                ok: true,
                status: p.kind === 'sandbox' ? 'simulated' : 'awaiting_approval',
                message: 'Resposta proposta. Nenhuma mensagem enviada. Encerre o turno.',
                // Foto por URL: nada foi buscado nem enviado; `foto_prevista` diz o que o envio real faria.
                ...(imagemPrevista !== undefined ? { foto_enviada: false, foto_prevista: imagemPrevista } : {}),
              };
            }
            if (catalog?.category === 'read')
              return {
                ok: false,
                error: {
                  code: 'scenario_contact_unavailable',
                  message: 'Esta consulta precisa de um contato real autorizado.',
                },
              };
            if (
              catalog ||
              [
                'send_template',
                'update_lead_state',
                'save_lead_note',
                'request_human_handoff',
                'schedule_followup',
                'open_human_case',
                'provide_case_update',
              ].includes(name)
            ) {
              p.result.proposals.push({ tool: name, arguments: args });
              return {
                ok: true,
                status: 'proposal_only',
                message:
                  'Proposta registrada. A operação não foi executada e exige autorização separada.',
              };
            }
            p.result.impediments.push({ code: 'unknown_preview_tool', message: name });
            return {
              ok: false,
              error: {
                code: 'unknown_preview_tool',
                message: 'Ferramenta não autorizada no teste.',
              },
            };
          },
        },
      ];
    }),
  ) as ToolSet;
}
export function scenarioContext(
  messages: LeadContext['messages'],
  contact?: { name?: string; phone?: string },
): Extract<LeadContextResult, { ok: true }> {
  return {
    ok: true,
    context: {
      lead_id: '',
      contact: {
        name: contact?.name ?? 'Teste',
        phone: contact?.phone ?? null,
        email: null,
        tags: [],
        is_blocked: false,
      },
      conversation_id: null,
      last_human_decision: null,
      messages,
    },
    tokenCount: 0,
    lgpd: {
      isAnonymized: false,
      isProspecting: false,
      legalBasis: { basis: null, consentGranted: false, legalBasisRef: null, dataOrigin: null },
    },
  };
}
