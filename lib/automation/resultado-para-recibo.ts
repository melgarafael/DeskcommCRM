import { ApiErrorCodes } from "@/lib/api/errors";
import { FRASES_DE_FALHA } from "@/lib/channels/frases-de-falha";
import type { ActionResultDetail } from "./types";

/** Vocabulário que os executores produzem, não texto devolvido pelo provedor.
 * Código novo entra explicitamente: formato parecido com código não basta
 * (um erro pode carregar telefone, CPF ou nome sem espaços).
 */
const CODIGOS_DAS_ACOES = new Set([
  "acao_alvo_desconhecida",
  "acao_fecharia_laco",
  "aguardando_o_canal",
  "ai_decide_desligado_na_empresa",
  "ai_decide_interruptor_ilegivel",
  "banco_do_roteiro_indisponivel",
  "canal_da_equipe_nao_encontrado",
  "canal_nao_suportado",
  "canal_sem_chave",
  "commercial_requires_human",
  "commercial_requires_human_sem_passagem",
  "config_invalida",
  "consent_declined",
  "contact_blocked",
  "continuacao_exige_outro_funil",
  "cross_pipeline_move_not_allowed",
  "custo_de_token_nao_registrado",
  "daily_limit",
  "dominio_nao_verificado",
  "dono_fora_da_equipe",
  "dono_sem_email",
  "elegibilidade_indeterminada",
  "email_limite_atingido",
  "email_nao_configurado",
  "email_recusado",
  "escolha_ausente",
  "escolha_fora_do_conjunto",
  "falha",
  "fila_vazia",
  "flow_not_active",
  "fora_da_janela_de_envio",
  "fora_da_lista_de_teste",
  "fora_do_pre_go_live",
  "ia_indisponivel",
  "internal_error",
  "invalid_owner",
  "lead_already_transferred_in_event",
  "lead_nao_encontrado",
  "live_enrollment_exists",
  "low_confidence",
  "membro_fora_da_equipe",
  "membro_indeterminado",
  "membro_sem_email",
  "missing_config",
  "missing_input",
  "missing_url",
  "modulo_desligado",
  "ninguem_disponivel",
  "no_contact",
  "no_email",
  "no_lead_or_contact",
  "no_phone",
  "no_tags",
  "no_target",
  "numero_de_teste",
  "origin_capture_failed",
  "plano_nao_encontrado",
  "remetente_recusado",
  "resposta_vazia",
  "roteiro_nao_iniciado",
  "sem_agente_publicado",
  "sem_alvo",
  "sem_dono",
  "sem_json",
  "sem_membro",
  "sem_numero_de_aviso_cadastrado",
  "sem_rodizio",
  "telefone_da_equipe_invalido",
  "texto_vazio",
  "titulo_vazio",
  "uma_vez_por_contato",
  "unknown_action",
  "user_not_in_org",
  "whatsapp_enviado",
  "whatsapp_falhou",
]);
const CODIGOS_DE_INFRA = new Set([
  "23502",
  "23503",
  "23505",
  "23514",
  "22P02",
  "42501",
  "42703",
  "42P01",
  "57014",
  "53300",
  "08000",
  "08006",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
]);
const FRASES_CONHECIDAS = new Set(Object.values(FRASES_DE_FALHA));
const TIPOS_DE_ERRO = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "TimeoutError",
  "AbortError",
]);
export const tipoDeErroConhecido = (valor: unknown): valor is string =>
  typeof valor === "string" && TIPOS_DE_ERRO.has(valor);

/** Apenas códigos fechados e frases constantes do próprio produto. */
export function erroTecnicoConhecido(valor: unknown): valor is string {
  return (
    typeof valor === "string" &&
    (CODIGOS_DAS_ACOES.has(valor) ||
      CODIGOS_DE_INFRA.has(valor) ||
      Object.hasOwn(ApiErrorCodes, valor) ||
      Object.hasOwn(FRASES_DE_FALHA, valor) ||
      FRASES_CONHECIDAS.has(valor) ||
      /^http_[1-5][0-9]{2}$/.test(valor) ||
      /^PGRST[0-9]{3}$/.test(valor))
  );
}

/** Captura a causa técnica ANTES de o executor perder o objeto do erro. */
export function falhaDeExecucaoParaRecibo(tipo: string, erro: unknown): ActionResultDetail {
  let codigo: string = ApiErrorCodes.internal_error;
  let classe = "Error";
  try {
    if (erro !== null && typeof erro === "object") {
      if ("code" in erro && erroTecnicoConhecido(erro.code)) codigo = erro.code;
      if (erro instanceof Error && tipoDeErroConhecido(erro.name)) classe = erro.name;
    }
  } catch {
    /* Getter do erro também é entrada não confiável. O piso é código fixo. */
  }
  return {
    type: tipo,
    status: "failed",
    error: codigo,
    detail: { error_code: codigo, error_type: classe },
  };
}

/**
 * O recibo sobrevive ao contato; mensagem livre de provedor não pode ir junto.
 * Mantém status, motivos conhecidos e metadados consumidos por Atividade e
 * Reenviar (IDs, Delivery/Attempt, horário e posição). Não altera o resultado
 * usado pelo agregador nem o objeto transitório devolvido pelo executor.
 */
export function resultadoParaRecibo(resultado: ActionResultDetail): ActionResultDetail {
  const copia = { ...resultado };
  const detalhe = resultado.detail ? { ...resultado.detail } : undefined;
  const codigo =
    [detalhe?.error_code, resultado.error, detalhe?.reason, detalhe?.code].find(
      (valor): valor is string => erroTecnicoConhecido(valor) && !FRASES_CONHECIDAS.has(valor),
    ) ?? ApiErrorCodes.internal_error;
  let textoLivre = false;
  if (resultado.error && !erroTecnicoConhecido(resultado.error)) {
    copia.error = codigo;
    textoLivre = true;
  }
  if (detalhe) {
    for (const chave of ["error", "erro", "reason", "error_code", "code"]) {
      const valor = detalhe[chave];
      if (valor === undefined || valor === null || valor === "") continue;
      if (!erroTecnicoConhecido(valor)) {
        detalhe[chave] = codigo;
        textoLivre = true;
      }
    }
  }
  if (detalhe?.error_type !== undefined && !tipoDeErroConhecido(detalhe.error_type)) {
    detalhe.error_type = "Error";
    textoLivre = true;
  }
  if (textoLivre) {
    if (!copia.error && resultado.status === "failed") copia.error = codigo;
    copia.detail = { ...detalhe, error_code: codigo };
  } else if (detalhe) copia.detail = detalhe;
  return copia;
}

export const resultadosParaRecibo = (
  resultados: readonly ActionResultDetail[],
): ActionResultDetail[] => resultados.map(resultadoParaRecibo);
