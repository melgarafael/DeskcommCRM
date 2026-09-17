"use client";

import { toast } from "sonner";
import { useT } from "@/hooks/i18n/useT";
import { traduzir } from "@/lib/i18n/dicionario";
import { idiomaAtual } from "@/lib/i18n/IdiomaProvider";
import { ApiError } from "@/lib/api/types";

type Variant = "error" | "warning" | "info";

/**
 * `msg` é OPCIONAL de propósito.
 *
 * Entrada COM `msg` substitui o texto da API — certo para código genérico, cuja
 * mensagem de servidor costuma ser técnica. Entrada SEM `msg` declara apenas o
 * TOM e deixa passar o texto que a rota mandou — certo quando a rota já escreve
 * melhor do que qualquer frase genérica conseguiria, porque ela tem o contexto:
 * o nome do tipo de agendamento, o motivo exato da disponibilidade inválida.
 *
 * A distinção nasceu de um erro medido: eu tinha escrito cinco frases de agenda
 * contra o NOME dos códigos, e uma delas estava errada — `agenda_fora_da_jornada`
 * não é "fora do expediente", é "esta pessoa ainda não publicou horários". O
 * nome enganou, e a mensagem da rota dizia certo. Escrever tradução contra o
 * código em vez de contra o comportamento é a mesma classe de defeito do
 * vocabulário duplicado, do lado da tradução.
 */
const COPY: Record<string, { variant: Variant; msg?: string }> = {
  body_malformed: {
    variant: "error",
    msg: "Requisição inválida. Recarregue e tente de novo.",
  },
  cursor_malformed: {
    variant: "error",
    msg: "Falha ao paginar. Volte ao início.",
  },
  validation_error: {
    variant: "error",
    msg: "Dados inválidos. Confira os campos destacados.",
  },
  auth_required: {
    variant: "warning",
    msg: "Sessão expirada. Faça login novamente.",
  },
  forbidden_role: {
    variant: "warning",
    msg: "Você não tem permissão para esta ação.",
  },
  resource_not_found: {
    variant: "error",
    msg: "Recurso não encontrado ou já removido.",
  },
  tenant_not_found: {
    variant: "error",
    msg: "Organização não encontrada.",
  },
  idempotency_conflict: {
    variant: "warning",
    msg: "Operação já processada.",
  },
  conversation_already_claimed: {
    variant: "warning",
    msg: "Outro atendente já assumiu.",
  },
  invalid_state: {
    variant: "warning",
    msg: "Este caso já foi respondido ou fechado.",
  },
  rate_limited: {
    variant: "warning",
    msg: "Calma — muitas tentativas. Espere alguns segundos.",
  },
  // Sem `msg`: a rota diz o que fazer (esperar, ou reparear), e o tom é de
  // espera, não de quebra — o número continua pareado.
  wacalls_not_connected: { variant: "warning" },
  lgpd_anonymization_irreversible: {
    variant: "error",
    msg: "Esta ação não pode ser desfeita: o contato já foi anonimizado.",
  },
  internal_error: {
    variant: "error",
    msg: "Erro interno. Tente de novo em instantes.",
  },

  // ---- Agenda ----
  //
  // Combinado da entrega: a frente da API declara o CÓDIGO, a frente da tela
  // declara a FRASE. Medindo antes de escrever, descobri que a metade da frase
  // JÁ estava feita e melhor: as rotas mandam `"Consulta" está desativado.` e
  // `A disponibilidade deste responsável está mal configurada: <motivo>` — com o
  // nome e o motivo interpolados, que nenhuma frase genérica minha alcança.
  //
  // O que faltava era o TOM. Sem entrada aqui, `showApiError` cai em
  // `toast.error`: VERMELHO para recusa rotineira, e vermelho para o que é
  // esperado ensina a ignorar vermelho. Estas quatro não são "algo quebrou",
  // são "não dá, e por isto" — daí `warning` sem `msg`.
  agenda_horario_indisponivel: { variant: "warning" },
  agenda_fora_da_jornada: { variant: "warning" },
  agenda_tipo_desativado: { variant: "warning" },
  agenda_sem_responsavel: { variant: "warning" },
  // Esta é da CONFIGURAÇÃO e não de quem está marcando — erro mesmo, e a rota
  // já diz qual campo está errado.
  agenda_disponibilidade_invalida: { variant: "error" },
  // Sem período/alvo a rota recusa em vez de devolver lista vazia — e está
  // certa: vazio faria a grade dizer "nada marcado" quando a verdade é que a
  // pergunta não tinha alvo. Para quem usa, isto é "escolha uma semana", não
  // "algo quebrou" — daí `info` e não `error`.
  agenda_listagem_sem_recorte: { variant: "info" },

  // ---- Motivo da perda (issue #917) ----
  //
  // Pelo mesmo critério das quatro de agenda acima: é recusa ROTINEIRA, não
  // quebra. O operador arrastou um card para a etapa de perda sem escolher a
  // causa — o card volta para onde estava e nada foi tocado. Vermelho aqui
  // ensina a ignorar vermelho, que é o que torna o vermelho de verdade invisível.
  //
  // Sem `msg` de propósito: a rota manda "Informe o motivo da perda." e, no
  // inválido, a frase que nomeia a lista do funil — texto mais específico do que
  // qualquer genérico daqui alcança.
  lost_reason_required: { variant: "warning" },
  lost_reason_invalid: { variant: "warning" },

  // ---- Chaves de IA em uso ----
  //
  // Recusa ROTINEIRA, não quebra: a chave está ligada a versões de agente e o
  // caminho certo é repontar (ou editar para girar). A ROTA manda a frase
  // específica — quantas versões, quais agentes —, então aqui só se declara o
  // TOM. Sem `msg` de propósito: a lista de agentes é contexto que nenhuma
  // frase genérica alcança.
  credential_in_use: { variant: "warning" },
};

/**
 * `t` chega pronto de fora: `showApiError` resolve via `idiomaAtual()` (fora da
 * árvore React), `useApiErrorHandler` via `useT()` (dentro dela). Nenhum dos
 * dois passa `t` como segundo parâmetro de `onError` — o TanStack Query chama
 * `onError(error, variables, context)`, e um segundo parâmetro aqui receberia
 * `variables` no lugar (foi exatamente o que aconteceu e quebrou o typecheck
 * em cadeia da primeira tentativa).
 */
function toastFor(err: unknown, t: (texto: string) => string): void {
  if (err instanceof ApiError) {
    const entry = COPY[err.code];
    const description = err.requestId ? `ID: ${err.requestId}` : undefined;
    if (entry) {
      const fn =
        entry.variant === "warning"
          ? toast.warning
          : entry.variant === "info"
            ? toast.info
            : toast.error;
      // `entry.msg ?? err.message`: entrada sem `msg` declara só o tom e deixa
      // passar o texto da rota, que costuma ser mais específico. Passa por
      // `t()` do mesmo jeito: o texto da rota é pt-BR literal (ver a seção
      // "Mensagens literais de `fail()`" em lib/i18n/dicionario.ts), e sem
      // tradução aqui chegaria em português na tela de quem escolheu espanhol.
      fn(entry.msg ? t(entry.msg) : t(err.message ?? err.code), { description });
      return;
    }
    toast.error(t(err.message) || err.code, { description });
    return;
  }
  toast.error(t("Erro inesperado. Tente novamente."));
}

/**
 * `showApiError` é passado por REFERÊNCIA como `onError` em ~80 lugares, a
 * maioria dentro de `useMutation` — não pode virar hook. `idiomaAtual()` lê o
 * espelho que `IdiomaProvider` mantém fora da árvore React para viabilizar
 * exatamente isto: traduzir sem mudar a assinatura pública da função.
 */
export function showApiError(err: unknown): void {
  toastFor(err, (texto) => traduzir(texto, idiomaAtual()));
}

export function useApiErrorHandler(): (err: unknown) => void {
  const t = useT();
  return (err: unknown) => toastFor(err, t);
}
