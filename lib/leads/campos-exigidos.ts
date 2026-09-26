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
import { camposDoFunil } from "@/lib/leads/campos-do-funil";
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
}

/** `undefined`/`null`/branco/array vazio são ausência; `false` e `0` são resposta. */
function valorPreenchido(valor: unknown): boolean {
  if (valor === undefined || valor === null) return false;
  if (typeof valor === "string") return valor.trim().length > 0;
  if (Array.isArray(valor)) return valor.length > 0;
  return true;
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
 * Devolve o que FALTA para esta escrita poder acontecer — nunca decide se a
 * escrita acontece (quem escreve é quem chama, e a recusa é 422 com esta lista
 * em `details.faltando`).
 *
 * A lista sai em ordem de cadastro dos campos, com `chave` (o que o PATCH do
 * dossiê espera) e `rotulo` (o que a pessoa lê): a tela monta o diálogo só com
 * o que falta, e a IA devolve os dois ao modelo para ele perguntar ao cliente.
 */
export function validaCamposExigidos(entrada: EntradaDeCampos): VereditoDeCampos {
  const faltando: CampoFaltando[] = [];
  const settings = settingsComoRecord(entrada.settingsDoFunil);
  const valores = {
    ...((entrada.lead.custom_fields as Record<string, unknown> | null | undefined) ?? {}),
    ...(entrada.customFieldsPropostos ?? {}),
  };

  for (const campo of camposDoFunil(settings)) {
    if (!campoExigidoNoDestino(campo, entrada.destino)) continue;
    if (valorPreenchido(valores[campo.key])) continue;
    faltando.push({
      chave: campo.key,
      rotulo: campo.label,
      tipo: campo.type,
      ...(campo.options ? { opcoes: campo.options } : {}),
    });
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
