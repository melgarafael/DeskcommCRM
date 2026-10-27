/**
 * OS CAMPOS QUE O FUNIL EXIGE — a pergunta única de TODOS os caminhos que mudam
 * etapa ou encerram (issue #1536).
 *
 * ─── O defeito que este arquivo fecha ──────────────────────────────────────
 *
 * `customFieldSchema.required` existia e não obrigava nada: aparecia como
 * asterisco no editor de ficha e nenhum caminho de escrita o consultava. Dá
 * para mover um negócio para "Proposta enviada" sem a data prevista, e fechá-lo
 * como perdido sem dizer de quem — a métrica de ganho e de concorrência nasce
 * vazia. O motivo da perda já tinha regra (issue #917, `motivo-da-perda.ts`);
 * isto é a generalização daquele padrão para QUALQUER campo declarado.
 *
 * ─── Uma função, seis caminhos ─────────────────────────────────────────────
 *
 * `validaCamposExigidos` é a ÚNICA decide-exigência do servidor. Quem a chama:
 *
 *   - `POST /api/v1/leads/[id]/move`  (arrasto no quadro)
 *   - `POST /api/v1/leads/bulk`       (movimento em lote)
 *   - `lib/leads/encerramento.ts`     (botão ganhar/perder, `/win`, `/lose`,
 *                                      clone da origem, `crm_close_demand`,
 *                                      ação `create_or_move_lead` no fecho)
 *   - `moveLeadHandler`               (MCP `crm_move_lead_stage`, ações)
 *
 * Duas respostas desta função divergiram no passado e por isso a decisão mora
 * num módulo só: uma rota que exigia e outra que não exigia é o mesmo defeito
 * da #917 com outro nome.
 *
 * ─── O que conta como preenchido ───────────────────────────────────────────
 *
 * Valor ausente é `undefined`, `null`, string em branco (depois de aparar) e
 * array vazio. `false` e `0` são RESPOSTAS e passam — uma checkbox respondida
 * "não" e um valor zero foram preenchidos; tratá-los como vazios faria um
 * booleano exigido ser impossível de satisfazer. `NaN`/`""` de número caem na
 * string/ausência conforme o valor gravado.
 *
 * ─── Compatibilidade ───────────────────────────────────────────────────────
 *
 * Um funil SEM `obrigatorio_em` num campo devolve `faltando: []` para qualquer
 * destino — é a regressão que o critério de aceite nº 3 veda: o comportamento de
 * hoje tem de sobreviver byte a byte. `required: true` (o asterisco antigo)
 * NÃO entra nesta decisão: ele continua significando "destaque no formulário".
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { traduzir } from "@/lib/i18n/dicionario";
import { IDIOMA_PADRAO, type Idioma } from "@/lib/i18n/idiomas";
import { camposDoFunil, escopoDoCampo } from "@/lib/leads/campos-do-funil";
import { logger } from "@/lib/logger";
import { camposVisiveis, condicaoCasa } from "@/lib/schemas/mostrar-quando";
import type { CustomFieldDef } from "@/lib/schemas/settings";

/**
 * `crm_pipelines.settings` do funil do lead — a carga que TODOS os caminhos
 * fazem antes de validar.
 *
 * ⚠️ FAIL-OPEN, e por decisão escrita: settings indisponível (erro de rede,
 * dublê de teste que não serve a tabela, id malformado) devolve `null`, que
 * valida como "nada exigido". A exigência é opt-in por configuração de funil,
 * e uma janela sem ela deixa o sistema como era ANTES desta issue; derrubar o
 * arrasto ou o encerramento porque a LEITURA das configurações falhou trocaria
 * um dado incompleto por uma operação impossível — e o caminho do "nada mudou"
 * é justamente o que o critério de aceite nº 3 manda preservar.
 *
 * Em erro de `error` (não-exceção) também não há 500 aqui: quem decide se a
 * escrita pode acontecer é quem chama `validaCamposExigidos`, e esta função só
 * traz o que o funil declarou.
 */
export async function settingsDoFunil(
  supabase: SupabaseClient,
  pipelineId: string | null | undefined,
): Promise<unknown> {
  if (!pipelineId) return null;
  try {
    const { data, error } = await supabase
      .from("crm_pipelines")
      .select("settings")
      .eq("id", pipelineId)
      .maybeSingle();
    if (error) return null;
    return (data as { settings?: unknown } | null)?.settings ?? null;
  } catch {
    return null;
  }
}

/** Um campo que a escrita pede e o lead não tem: chave + rótulo para a tela. */
export interface CampoFaltando {
  chave: string;
  rotulo: string;
  /**
   * O tipo do campo (`text`, `date`, `select`…) e as opções de um `select` —
   * ADITIVO ao contrato `{chave, rotulo}` da issue: a tela do diálogo precisa
   * dele para renderizar o input certo (uma data pede calendário, um select
   * pede as opções cadastradas). Quem só lê `chave`/`rotulo` não muda nada.
   */
  tipo?: CustomFieldDef["type"];
  opcoes?: { value: string; label: string }[];
  /**
   * A cobrança vem da ETAPA (ou do fechamento), não da condição — e a condição
   * de visibilidade mandaria esconder este campo (#3036).
   *
   * Existe porque a composição das duas réguas tem um caso em que a tela
   * precisaria de uma frase: campo escondido PELA CONDIÇÃO e exigido PELA
   * ETAPA não pode virar bloqueio invisível. A etapa vence (é regra do dono do
   * funil, e ignorá-la abriria um buraco de dado em silêncio), e este marcador
   * é o que autoriza a tela a dizer POR QUE o campo está ali em vez de mostrar
   * um campo a mais sem explicação. Ausente no caminho comum — quem só lê
   * `chave`/`rotulo` não muda nada.
   */
  exigido_pela_etapa?: boolean;
}

/** O veredito: lista vazia = pode escrever. */
export interface VereditoDeCampos {
  faltando: CampoFaltando[];
}

/** O que a escrita faz com o negócio — os três gatilhos de exigência. */
export interface DestinoDaEscrita {
  /** Etapa de destino da escrita (para `obrigatorio_em.etapas`). */
  stageId?: string | null;
  /** `won`/`lost` quando a escrita fecha o negócio; `null` quando só move. */
  desfecho?: "won" | "lost" | null;
}

interface EntradaDeCampos {
  lead: Record<string, unknown>;
  /** `crm_pipelines.settings` cru (ou `null` — funil desconhecido = nada exigido). */
  settingsDoFunil: unknown;
  destino: DestinoDaEscrita;
  /**
   * O motivo de ganho que esta escrita traz (rota `/win`, `crm_close_demand`).
   * Vem separado porque ele NÃO mora em `custom_fields`: é coluna própria
   * (`crm_leads.won_reason`) e o lead recém-lido ainda não o tem.
   */
  motivoDeGanho?: string | null;
  /**
   * Os valores que a escrita TRAZ junto (o diálogo de campos obrigatórios
   * reenvia o move com eles — issue #1536). A validação olha o VALOR
   * COMBINADO (`lead.custom_fields` + propostos), senão a segunda tentativa
   * cairia na mesma recusa da primeira: o lead ainda não foi gravado.
   */
  customFieldsPropostos?: Record<string, unknown> | null;
  /**
   * As chaves de campo `file` que TÊM anexo em `crm_lead_attachments` (#3229) —
   * de `camposComAnexo()`. Campo de arquivo não se lê de `custom_fields`: a
   * lista lá seria uma segunda fonte, e um `custom_fields` forjado passaria a
   * régua sem arquivo nenhum. Ausente = nenhum anexo — e por isso a CRIAÇÃO
   * precisa da opção abaixo: o negócio que ainda vai nascer não tem como ter
   * anexo, e sem `semAnexosAinda` a exigência vira impossibilidade (#3433).
   */
  camposComAnexo?: ReadonlySet<string> | null;
  /**
   * A CRIAÇÃO de um negócio: o anexo é do negócio (`crm_lead_attachments.lead_id`)
   * e só pode ser enviado DEPOIS que ele existe, então o campo `file` não é
   * cobrado aqui (#3433). Volta a ser cobrado no próximo move, no lote ou no
   * fechamento, onde o servidor lê os anexos de verdade (`camposComAnexo`).
   *
   * Só os caminhos de criação passam esta opção (`createLeadHandler` e o
   * `NewLeadDialog`). Ela é explícita de propósito: um padrão "ausente = pula"
   * teria afrouxado o move em silêncio, que é o caminho em que o arquivo PODE
   * existir.
   */
  semAnexosAinda?: boolean;
}

/** `undefined`/`null`/branco/array vazio são ausência; `false` e `0` são resposta. */
function valorPreenchido(valor: unknown): boolean {
  if (valor === undefined || valor === null) return false;
  if (typeof valor === "string") return valor.trim().length > 0;
  if (Array.isArray(valor)) return valor.length > 0;
  return true;
}

/**
 * Quais campos `file` exigíveis deste funil têm anexo neste negócio (#3229).
 *
 * Só consulta quando o funil TEM campo de arquivo com `obrigatorio_em`: todo
 * funil sem ele (o caso comum) não paga a ida ao banco. `organization_id` vai
 * explícito porque metade dos chamadores usa o cliente admin.
 *
 * Falha FECHADA: sem a leitura, o campo conta como vazio e a escrita é
 * recusada com a lista do que falta — melhor pedir o anexo de novo do que
 * mover o negócio sem o documento que o funil exige.
 */
export async function camposComAnexo(
  supabase: SupabaseClient,
  settings: unknown,
  organizationId: string,
  leadId: string,
): Promise<ReadonlySet<string>> {
  const exigiveis = camposDoFunil(settingsComoRecord(settings)).some(
    (campo) => campo.type === "file" && campo.obrigatorio_em,
  );
  if (!exigiveis) return new Set();
  const { data, error } = await supabase
    .from("crm_lead_attachments")
    .select("field_key")
    .eq("organization_id", organizationId)
    .eq("lead_id", leadId);
  if (error) {
    logger.warn("[campos-exigidos] anexos não lidos; o campo de arquivo conta como vazio", {
      leadId,
      erro: error.message,
    });
    return new Set();
  }
  return new Set(((data ?? []) as { field_key: string }[]).map((linha) => linha.field_key));
}

/** O `settings` do funil como record tolerante — lixo vira objeto vazio. */
function settingsComoRecord(settings: unknown): Record<string, unknown> {
  return settings && typeof settings === "object" && !Array.isArray(settings)
    ? (settings as Record<string, unknown>)
    : {};
}

/**
 * O campo é exigido NESTE destino? — a régua de `obrigatorio_em`.
 *
 * `etapas` compara por ID (a mesma comparação que a tela faz ao montar o
 * diálogo); `ao_ganhar`/`ao_perder` valem para a escrita que fecha o negócio.
 * Um campo sem `obrigatorio_em` nunca é exigido — este é o caminho da
 * compatibilidade, e é o mais comum: todo funil instalado hoje está aqui.
 */
function campoExigidoNoDestino(
  campo: CustomFieldDef,
  destino: DestinoDaEscrita,
): boolean {
  const regra = campo.obrigatorio_em;
  if (!regra) return false;
  if (destino.stageId && regra.etapas?.includes(destino.stageId)) return true;
  if (destino.desfecho === "won" && regra.ao_ganhar) return true;
  if (destino.desfecho === "lost" && regra.ao_perder) return true;
  return false;
}

/**
 * OS CAMPOS QUE ESTE DESTINO EXIGE — a lista, não o veredito.
 *
 * É o recorte que a régua de baixo percorre, e é a MESMA pergunta que a TELA
 * precisa fazer para saber o que desenhar (issue #3038): o `NewLeadDialog`
 * monta o formulário com esta lista em vez de reimplementar `obrigatorio_em`
 * — duas cópias da regra divergiriam, e a tela voltaria a esconder um campo
 * que o servidor cobra.
 *
 * Campo do CONTATO (issue #2791) fica de fora: ele nem aparece no card, e o
 * valor mora em `contacts.custom_fields` — exigi-lo numa etapa do funil
 * barraria o negócio por um campo que a tela do funil não mostra. Marcas de
 * `obrigatorio_em` num campo `contato` são inertes.
 *
 * A VISIBILIDADE (`mostrar_quando`, #2728) NÃO é decidida aqui: ela depende dos
 * valores, e quem os tem em mãos é a régua (a lista de `faltando`) e o
 * `CustomFieldsEditor` no formulário.
 */
export function camposExigidosNoDestino(
  settingsDoFunil: unknown,
  destino: DestinoDaEscrita,
): CustomFieldDef[] {
  return camposDoFunil(settingsComoRecord(settingsDoFunil)).filter(
    (campo) => escopoDoCampo(campo) === "negocio" && campoExigidoNoDestino(campo, destino),
  );
}

/**
 * OS CAMPOS QUE UMA CONDIÇÃO EXIGE — o recorte de `exigir_quando` (#3036).
 *
 * É a segunda pergunta da obrigatoriedade, ao lado de `obrigatorio_em`: "este
 * campo é exigido SEMPRE nesta etapa/gatilho" e "este campo é exigido QUANDO
 * outro tem determinado valor" convivem, e quem responde as duas é esta
 * dupla de funções — não há uma terceira cópia da regra em lugar nenhum.
 *
 * Só campo do NEGÓCIO entra, pela mesma razão de `camposExigidosNoDestino`:
 * campo do contato nem aparece no card.
 *
 * A visibilidade NÃO é filtrada aqui — quem a decide precisa dos valores, e é
 * a régua (`validaCamposExigidos`) que os tem.
 */
export function camposComExigenciaCondicional(settingsDoFunil: unknown): CustomFieldDef[] {
  return camposDoFunil(settingsComoRecord(settingsDoFunil)).filter(
    (campo) => escopoDoCampo(campo) === "negocio" && campo.exigir_quando !== undefined,
  );
}

/**
 * Devolve o que FALTA para esta escrita poder acontecer — nunca decide se a
 * escrita acontece (quem escreve é quem chama, e a recusa é 422 com esta lista
 * em `details.faltando`).
 *
 * A lista sai em ordem de cadastro dos campos, com `chave` (o que o PATCH do
 * dossiê espera) e `rotulo` (o que a pessoa lê): a tela monta o diálogo só com
 * o que falta, e a IA devolve os dois ao modelo para ele perguntar ao cliente.
 *
 * ─── Duas réguas, uma decisão (issue #3036) ────────────────────────────────
 *
 * A obrigatoriedade tem DUAS origens, e elas se somam:
 *
 *   1. `obrigatorio_em` — a etapa de destino, o ganho, a perda (issue #1536);
 *   2. `exigir_quando` — o valor de outro campo do mesmo funil (#3036).
 *
 * A condição de VISIBILIDADE (`mostrar_quando`) não substitui nenhuma das
 * duas, e a composição tem duas metades:
 *
 *   - exigido pela CONDIÇÃO e escondido → não cobra. É a promessa da #2728:
 *     quem não vê o campo não tem como preenchê-lo, e cobrar o que a tela
 *     esconde transforma "esconder" em "travar";
 *   - exigido pela ETAPA e escondido → COBRA, marcado com
 *     `exigido_pela_etapa`. A etapa é regra do dono do funil e ignorá-la
 *     abriria um buraco de dado em silêncio (o motivo do #1536 existir). O
 *     marcador é o que faz a tela DIZER por que o campo está sendo pedido, em
 *     vez de bloquear sem explicação.
 */
export function validaCamposExigidos(entrada: EntradaDeCampos): VereditoDeCampos {
  const faltando: CampoFaltando[] = [];
  const settings = settingsComoRecord(entrada.settingsDoFunil);
  const valores = {
    ...((entrada.lead.custom_fields as Record<string, unknown> | null | undefined) ?? {}),
    ...(entrada.customFieldsPropostos ?? {}),
  };

  const campos = camposDoFunil(settings);
  const visiveis = new Set(camposVisiveis(campos, valores).map((campo) => campo.key));

  /** Cobra o campo (se vazio) e o registra na lista — o único ponto de push. */
  const cobra = (campo: CustomFieldDef, exigidoPelaEtapa: boolean): void => {
    // A CRIAÇÃO não cobra o arquivo (#3433): o anexo é do negócio que ainda vai
    // nascer. Sem esta linha o campo `file` conta sempre como vazio na criação
    // (não há `camposComAnexo` para ler) e a etapa que exige documento vira
    // impossível de entrar — nem pela tela, nem pela API, nem pela captação.
    if (campo.type === "file" && entrada.semAnexosAinda) return;
    const preenchido =
      campo.type === "file"
        ? (entrada.camposComAnexo?.has(campo.key) ?? false)
        : valorPreenchido(valores[campo.key]);
    if (preenchido) return;
    faltando.push({
      chave: campo.key,
      rotulo: campo.label,
      tipo: campo.type,
      ...(campo.options ? { opcoes: campo.options } : {}),
      ...(exigidoPelaEtapa ? { exigido_pela_etapa: true } : {}),
    });
  };

  // ── 1. A RÉGUA DA ETAPA (#1536) — escopo e destino filtrados pelo recorte
  // compartilhado com a tela (`camposExigidosNoDestino`).
  for (const campo of camposExigidosNoDestino(settings, entrada.destino)) {
    if (visiveis.has(campo.key)) {
      cobra(campo, false);
      continue;
    }
    // Escondido pela condição, exigido pela etapa: a ETAPA vence, e a cobrança
    // vai marcada para a tela poder explicar (ver o doc acima).
    cobra(campo, true);
  }

  // ── 2. A RÉGUA DA CONDIÇÃO (#3036) — campo que o VALOR de outro campo exige.
  for (const campo of camposComExigenciaCondicional(settings)) {
    // Já cobrado pela etapa: uma linha só na lista, com o motivo mais forte.
    if (faltando.some((c) => c.chave === campo.key)) continue;
    // Escondido, a condição não cobra — a metade que preserva a #2728.
    if (!visiveis.has(campo.key)) continue;
    if (!condicaoCasa(campo.exigir_quando, valores)) continue;
    cobra(campo, false);
  }

  // O MOTIVO DE GANHO NATIVO (issue #1536): coluna própria, lista própria,
  // opt-in por funil. Sem `won_reason_required` no settings ele nunca entra —
  // de novo, o caminho do "nada mudou" é o padrão.
  if (
    entrada.destino.desfecho === "won" &&
    settings.won_reason_required === true &&
    !valorPreenchido(entrada.motivoDeGanho ?? entrada.lead.won_reason)
  ) {
    faltando.push({ chave: "won_reason", rotulo: "Motivo do ganho" });
  }

  return { faltando };
}

/**
 * A recusa pronta, no idioma pedido — o texto que todas as rotas devolvem.
 * A lista de faltando vai no `details`, nunca na frase: a frase é para quem
 * lê no toast, o `details` é para quem programa contra a API.
 */
export function recusaDeCamposObrigatorios(
  faltando: CampoFaltando[],
  idioma?: Idioma | null,
): { codigo: "required_fields_missing"; mensagem: string } {
  // Só o rótulo nativo tem tradução; o de campo personalizado é texto do funil.
  const nomes = faltando
    .map((c) =>
      c.chave === "won_reason" ? traduzir("Motivo do ganho", idioma ?? IDIOMA_PADRAO) : c.rotulo,
    )
    .join(", ");
  return {
    codigo: "required_fields_missing",
    mensagem: traduzir(
      "Preencha os campos obrigatórios antes de continuar: {campos}.",
      idioma ?? IDIOMA_PADRAO,
    ).replace("{campos}", nomes),
  };
}

/**
 * O motivo de ganho está no vocabulário do funil? — espelho de
 * `recusaDeMotivoForaDoVocabulario`, com DUAS diferenças honestas:
 *
 * 1. Não há trigger para o ganho no banco (a CHECK `crm_leads_lost_reason_required`
 *    é só da perda), então quem aplica é esta função, no servidor.
 * 2. Sem `settings.won_reasons` cadastrado o motivo é TEXTO LIVRE — a lista
 *    amplia quando existe, e não existe por padrão. Exigir lista vazia seria
 *    tornar `won_reason_required` impossível de satisfazer.
 *
 * Devolve `null` quando não há o que recusar (sem motivo, ou motivo aceito).
 */
export function recusaDeMotivoDoGanho(input: {
  motivo?: string | null;
  settingsDoFunil: unknown;
  idioma?: Idioma | null;
}): { codigo: "won_reason_invalid"; mensagem: string } | null {
  const motivo = (input.motivo ?? "").trim();
  if (motivo.length === 0) return null;

  const cadastrados = settingsComoRecord(input.settingsDoFunil).won_reasons;
  if (!Array.isArray(cadastrados) || cadastrados.length === 0) return null;

  const aceitos = new Set(
    cadastrados.filter((v): v is string => typeof v === "string"),
  );
  if (aceitos.has(motivo)) return null;

  return {
    codigo: "won_reason_invalid",
    mensagem: traduzir(
      "Este motivo de ganho não está na lista do funil. Escolha um dos motivos cadastrados.",
      input.idioma ?? IDIOMA_PADRAO,
    ),
  };
}
