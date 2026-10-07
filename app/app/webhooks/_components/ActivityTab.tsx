"use client";

import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";

import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";

import type { Locale } from "date-fns";
import * as React from "react";
import { toast } from "sonner";
import { formatDistanceToNowStrict } from "date-fns";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Check,
  X,
  SkipForward,
  ArrowsClockwise,
  PaperPlaneTilt,
  ClockCountdown,
} from "@/lib/ui/icons";
import { cn } from "@/lib/utils";
import {
  useAutomationRuns,
  useResendAutomationRun,
  type AutomationRuleRunRow,
  type AutomationRuleRunActionResult,
} from "@/hooks/webhooks/useAutomationRules";
import { ACTION_LABELS, type ActionType } from "./labels";
import { useT } from "@/hooks/i18n/useT";

function actionLabel(type: string, t: (texto: string) => string): string {
  return t(ACTION_LABELS[type as ActionType] ?? type);
}

function relativeCreatedAt(iso: string, locale: Locale): string {
  return formatDistanceToNowStrict(new Date(iso), { addSuffix: true, locale: locale });
}

function statusBadgeVariant(
  status: AutomationRuleRunRow["status"],
): "success" | "error" | "warning" | "info" {
  if (status === "success") return "success";
  if (status === "failed") return "error";
  if (status === "adiado") return "info";
  return "warning";
}

function statusBadgeLabel(status: AutomationRuleRunRow["status"], t: (texto: string) => string): string {
  if (status === "success") return t("Sucesso");
  if (status === "failed") return t("Falhou");
  // "Aguardando envio", e não "Aguardando horário": desde que o agregador passou
  // a marcar `adiado` também quando a mensagem ficou na fila do canal (número
  // desconectado, transporte não configurado), o rótulo antigo afirmava uma
  // causa — o relógio — que muitas vezes não é a certa. A causa exata aparece
  // na linha da ação, logo abaixo, onde ela pode ser específica.
  if (status === "adiado") return t("Aguardando envio");
  return t("Parcial");
}

/**
 * POR QUE a ação não aconteceu, em português.
 *
 * Os motivos técnicos vinham no `detail.reason` e NUNCA chegavam à tela: o ícone
 * de "pulou" aparecia sozinho, e quem montou a automação ficava sem saber se o
 * contato estava bloqueado, sem telefone, ou se a regra simplesmente não tinha
 * a quem escrever. `explicacao` é a frase que o backend já monta quando conhece
 * o caso (ver lib/automation/desfecho-do-envio.ts); este mapa cobre os motivos
 * que nascem no próprio executor.
 */
const MOTIVO_DA_PARADA: Record<string, string> = {
  no_contact: "Esse lead entrou sem contato vinculado, então não havia para quem escrever.",
  contact_blocked: "O contato pediu para não receber mensagens (opt-out).",
  no_phone: "O contato não tem telefone cadastrado.",
  missing_config: "Falta preencher alguma configuração desta ação — abra a automação e revise.",
  fora_da_janela_de_envio:
    "Está fora da janela de envio configurada para esse número. A mensagem sai sozinha quando ela reabrir.",
  aguardando_o_canal: "A mensagem está na fila e sai assim que o canal aceitar.",
  sem_agente_publicado:
    "O agente escolhido não tem versão publicada. Publique-o em Agentes de IA para a automação poder usá-lo.",
  ia_indisponivel:
    "A IA não está configurada nesta instalação — cadastre uma chave em Provedores de IA.",
  texto_vazio: "A IA não devolveu texto. Revise o contexto que você escreveu para ela.",
  /*
   * Os motivos abaixo chegam à tela pelos mesmos dois canais que os de cima
   * (`detail.reason` e `action.error`) e NÃO tinham frase: quem opera a
   * automação lia o código cru. A lista não é mantida a olho —
   * `tests/unit/motivo-de-parada-tem-frase.test.ts` varre o que as ações emitem
   * e reprova motivo sem frase aqui, com arquivo e linha de quem o emitiu.
   */
  membro_indeterminado:
    "Não deu para saber quem atende este contato: a consulta ao sistema falhou na hora (rede ou banco), e não é erro de configuração. Tente de novo em alguns minutos.",
  user_not_in_org:
    "A pessoa escolhida como responsável não é atendente desta equipe. Escolha outra pessoa na automação.",
  invalid_owner:
    "A pessoa escolhida como responsável não pode atender — o papel dela é só de visualização. Escolha um atendente.",
  missing_input:
    "A ação não recebeu o que precisava (o lead do evento ou a pessoa configurada). Abra a automação e revise.",
  no_tags: "Esta ação não tem nenhuma etiqueta escolhida. Abra a automação e escolha pelo menos uma.",
  no_target: "O evento que disparou a regra não trouxe um lead nem um contato para etiquetar.",
  no_lead_or_contact: "O evento que disparou a regra não trouxe um lead para criar ou mover.",
  cross_pipeline_move_not_allowed: "Mover um lead para outro funil está desligado nesta organização.",
  lead_already_transferred_in_event:
    "Outra regra deste mesmo evento já levou o lead para outro funil. Vale a primeira regra; esta não transfere de novo.",
  flow_not_active:
    "O funil escolhido não está ativo, então a inscrição não foi feita. Ative o funil ou escolha outro na automação.",
  live_enrollment_exists: "O contato já está em um funil ativo — esta ação não inscreve duas vezes.",
  consent_declined: "O contato não autorizou o recebimento de mensagens de marketing.",
  fora_do_pre_go_live:
    "O número deste canal ainda não entrou no pré-go-live, então a mensagem escrita pela IA não sai por ele.",
  numero_de_teste: "Este número está marcado como número de teste do canal.",
  fora_da_lista_de_teste:
    "Este número está fora da lista de teste do canal, então a mensagem escrita pela IA não sai por ele.",
  elegibilidade_indeterminada:
    "Não deu para saber se este número pode receber a mensagem da IA: a consulta falhou na hora (rede ou banco), e não é erro de configuração. Tente de novo em alguns minutos.",
  missing_url: "Esta ação de webhook não tem endereço configurado. Abra a automação e preencha.",
  unknown_action:
    "A regra usa um tipo de ação que esta instalação não tem (pode ter saído em uma atualização). Abra a automação e escolha outra ação.",
  // #1528 — o motor pula atribuir/mover nos gatilhos do trigger (laço).
  acao_fecharia_laco:
    "Neste gatilho esta ação não roda: atribuir responsável ou mover o lead dispararia a automação de novo, sem fim. Abra a automação e tire a ação.",
  /*
   * #1540 — a ação criar tarefa. Estes quatro não passam por literal nenhum
   * em lib/automation: nascem em lib/tarefas/criar-tarefa.ts como
   * `resultado.codigo` e chegam aqui pelo `reason` da ação (declaração em
   * ORIGENS, no teste da guarda). A guarda não os varre — o produtor só lê
   * propriedade chamada `reason`/`motivo`, e lá o nome é `codigo` —, então a
   * lista é escrita a mão aqui por quem conhece o caso: sem ela a tela
   * mostraria o código cru, que é o defeito da #1090.
   */
  sem_alvo:
    "A tarefa não foi criada: o evento que disparou a regra não trouxe um lead nem um contato para pendurar nela.",
  sem_dono:
    "A tarefa não foi criada: a pessoa escolhida como responsável não ficou resolvida para esta tarefa. Escolha outro responsável na automação.",
  titulo_vazio:
    "A tarefa não foi criada: o título ficou vazio depois de preencher os campos do texto. Escreva um título que não dependa só de dado que faltou.",
  falha:
    "A tarefa não foi criada: o banco recusou a gravação. Tente de novo em alguns minutos; se persistir, abra a tarefa na agenda para ver o detalhe.",
  /* #1970 — a ação ai_decide. Estes quatro nascem aqui em lib/automation/actions/ai-decide.ts
     e chegam ao run por `detail.reason`/`action.error` (mesmo casal de canais da guarda). */
  custo_de_token_nao_registrado:
    "A ação não rodou: a regra foi gravada sem declarar o gasto de IA (custo_de_token). Corrija a regra pela API; este passo ainda não tem tela.",
  config_invalida:
    "A ação não rodou: a instrução ou as opções estão incompletas. Abra a automação e revise o texto e as alternativas.",
  escolha_fora_do_conjunto:
    "A IA devolveu uma opção que não está na lista desta ação, então nada foi executado. Corrija a instrução da regra para deixar as opções mais claras.",
  acao_alvo_desconhecida:
    "A opção escolhida aponta para uma ação que esta instalação não tem (pode ter saído em uma atualização). Abra a automação e escolha outra ação.",
  /* #2367 — o interruptor POR EMPRESA: o quinto motivo que nasce no mesmo arquivo,
     e o único que a tela pode consertar por aqui (o caminho está na própria frase). */
  ai_decide_desligado_na_empresa:
    "A ação não rodou: o interruptor desta empresa desligou todos os passos a IA decide, então o modelo não foi consultado e nada foi executado. Ligue o interruptor em Configurações, na tela Automações.",
  /* #2367 — o mesmo interruptor, mas ILEGÍVEL: erro de leitura não vira "ligado"
     (o operador pode ter desligado) nem "desligado" (a tela mentiria sobre quem). */
  ai_decide_interruptor_ilegivel:
    "A ação não rodou: não deu para ler agora o interruptor da IA desta empresa, então o modelo não foi consultado e nada foi executado. As próximas execuções tentam de novo.",
  /* vêm do decider (lib/automation/decider.ts) pelo mesmo `decisao.motivo`. */
  resposta_vazia: "A IA não devolveu nenhuma escolha entre as opções desta ação. Tente de novo ou corrija a instrução.",
  sem_json: "A IA respondeu fora do formato esperado e nada foi executado. Tente de novo em alguns minutos.",
  escolha_ausente: "A IA respondeu sem dizer qual opção escolher, então nada foi executado. Tente de novo ou corrija a instrução.",
};

function explicacaoDe(
  action: AutomationRuleRunActionResult,
  t: (texto: string) => string,
): string | null {
  const detail = action.detail ?? {};
  if (typeof detail.explicacao === "string") return t(detail.explicacao);
  // O motivo chega por DOIS canais: `detail.reason` (quem monta o detalhe) e
  // `action.error` (quem devolve só o código — `user_not_in_org` e
  // `invalid_owner` são assim). Consultar só o primeiro deixava esses dois como
  // código cru na tela, mesmo com frase no mapa (issue #1090).
  const doDetalhe = typeof detail.reason === "string" ? detail.reason : null;
  const doErro = typeof action.error === "string" ? action.error : null;
  const motivo = doDetalhe ?? doErro;
  if (motivo && MOTIVO_DA_PARADA[motivo]) return t(MOTIVO_DA_PARADA[motivo]);
  return motivo;
}

/**
 * O detalhe TÉCNICO da execução — a mensagem crua que a ação guardou.
 *
 * ─── DECISÃO DA ISSUE #1090: ele APARECE, para quem dá suporte ──────────────
 *
 * O critério, escrito para quem revisar:
 *
 *   - QUEM LÊ: a aba Atividade é de quem opera a automação dentro do produto,
 *     não é tela de cliente. Para essa pessoa, "não deu para saber quem atende"
 *     sem o motivo é beco sem saída: é a mensagem que separa "a infraestrutura
 *     caiu" (tente de novo) de "o cadastro está errado" (conserte o cadastro), e
 *     é ela que o suporte leva ao time técnico;
 *   - O QUE É: mensagem de erro de infraestrutura que a própria ação capturou
 *     (`TypeError: fetch failed`) — não é dado pessoal nem segredo, e o mesmo
 *     texto já está em `automation_rule_runs.actions_result`, na resposta da API
 *     que a própria tela consome;
 *   - ORDEM E PESO: a frase em português continua sendo a leitura principal —
 *     ela vem primeiro, e o texto técnico vem rotulado e em corpo menor. É o que
 *     impede o detalhe de voltar a ACUSAR a configuração, que foi o defeito
 *     consertado a montante (PR #1010).
 *
 * As duas grafias são aceitas porque as ações usam as duas (`detail.erro` em
 * `assign_owner`, `detail.error` nas demais).
 */
function detalheTecnicoDe(action: AutomationRuleRunActionResult): string | null {
  const detail = action.detail ?? {};
  for (const chave of ["erro", "error"]) {
    const valor = detail[chave];
    if (typeof valor === "string" && valor.trim()) return valor.trim();
  }
  return null;
}

function horarioDeRetorno(action: AutomationRuleRunActionResult, idioma: string): string | null {
  const retryAt = action.detail?.retry_at;
  if (typeof retryAt !== "string") return null;
  const quando = new Date(retryAt);
  if (Number.isNaN(quando.getTime())) return null;
  return quando.toLocaleString(idioma, { dateStyle: "short", timeStyle: "short" });
}

function ActionLine({ action, run }: { action: AutomationRuleRunActionResult; run: AutomationRuleRunRow }) {
  const tagDoIdioma = useTagDeIdioma();
  const t = useT();
  const resend = useResendAutomationRun();

  const icon =
    action.status === "success" ? (
      <Check className="h-4 w-4 shrink-0 text-success" />
    ) : action.status === "failed" ? (
      <X className="h-4 w-4 shrink-0 text-error" />
    ) : action.status === "postponed" ? (
      <ClockCountdown className="h-4 w-4 shrink-0 text-muted-foreground" />
    ) : (
      <SkipForward className="h-4 w-4 shrink-0 text-muted-foreground" />
    );

  // A explicação vale TAMBÉM em `failed` — era aqui que os motivos da ação de
  // IA (`sem_agente_publicado`, `ia_indisponivel`, `texto_vazio`) morriam: eles
  // chegam em `action.error` como CÓDIGO, o ramo de falha imprime `error` cru, e
  // o mapa de frases logo acima nunca era consultado. Escrever as frases e não
  // ligá-las é o mesmo que não tê-las.
  const explicacao = explicacaoDe(action, t);
  const detalheTecnico = detalheTecnicoDe(action);
  const retorno = horarioDeRetorno(action, tagDoIdioma);

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 text-sm">
        {icon}
        <span>{actionLabel(action.type, t)}</span>
      </div>
      {action.status === "failed" ? (
        // `action.error` é texto de fora (resposta do webhook externo) — sem
        // tamanho garantido. `flex-wrap` + `break-words` impedem que um erro
        // comprido empurre o botão "Reenviar" pra fora da tela.
        <div className="ml-6 flex flex-wrap items-center justify-between gap-2 rounded-sm bg-muted px-2 py-1.5">
          <div className="min-w-0 space-y-0.5">
            <p className="break-words text-xs text-muted-foreground">
              {/* A frase ANTES do código cru. `action.error` já é texto de gente
                  nas falhas de envio (desfechoDoEnvio traduz), mas nas falhas da
                  IA ele é o código (`sem_agente_publicado`) — e é para esses que
                  `explicacao` existe. O `??` mantém o erro do webhook externo,
                  que não tem tradução possível e é a única pista real. */}
              {explicacao ?? action.error ?? t("Essa ação não funcionou.")}
            </p>
            {detalheTecnico ? (
              // Subordinado à frase, e não no lugar dela: ver a decisão escrita
              // em `detalheTecnicoDe`.
              <p className="break-words text-[11px] text-muted-foreground">
                {t("Detalhe técnico:")} {detalheTecnico}
              </p>
            ) : null}
          </div>
          {action.type === "call_webhook" ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="shrink-0"
              disabled={resend.isPending}
              onClick={() =>
                resend.mutate(run.id, {
                  onSuccess: () => toast.success(t("Reenviado.")),
                })
              }
            >
              <PaperPlaneTilt /> {t("Reenviar")}
            </Button>
          ) : null}
        </div>
      ) : explicacao ? (
        // Pular e adiar também precisam de razão visível: o ícone sozinho fazia
        // "não fiz nada" parecer "fiz e deu certo, só sem alarde".
        <div className="ml-6 rounded-sm bg-muted px-2 py-1.5">
          <p className="break-words text-xs text-muted-foreground">
            {explicacao}
            {retorno ? ` ${t("Nova tentativa em")} ${retorno}.` : null}
          </p>
          {detalheTecnico ? (
            <p className="break-words text-[11px] text-muted-foreground">
              {t("Detalhe técnico:")} {detalheTecnico}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function ActivityTab() {
  const localeDaData = useLocaleDeData();
  const t = useT();
  const { data, isLoading, refetch, isRefetching } = useAutomationRuns();
  const runs = data?.data ?? [];

  return (
    <div className="space-y-4 pt-4">
      <div className="flex sm:justify-end">
        <Button
          type="button"
          variant="secondary"
          onClick={() => refetch()}
          disabled={isRefetching}
          className="w-full sm:w-auto"
        >
          <ArrowsClockwise className={cn(isRefetching && "animate-spin")} /> {t("Atualizar")}
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : runs.length === 0 ? (
        <div className="flex justify-center pt-10">
          <Card className="max-w-md">
            <CardContent className="pt-6 text-center text-sm text-muted-foreground">
              {t(
                "Nenhuma automação rodou ainda. Assim que uma regra ligada disparar, o histórico aparece aqui.",
              )}
            </CardContent>
          </Card>
        </div>
      ) : (
        <div className="space-y-3">
          {runs.map((run) => (
            <Card key={run.id}>
              <CardHeader className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="truncate text-sm">
                    {run.automation_rules?.name ?? t("Automação removida")}
                  </CardTitle>
                  <Badge variant={statusBadgeVariant(run.status)}>{statusBadgeLabel(run.status, t)}</Badge>
                </div>
                <p className="text-xs text-muted-foreground">{relativeCreatedAt(run.created_at, localeDaData)}</p>
              </CardHeader>
              <CardContent className="space-y-2">
                {run.actions_result.map((action, idx) => (
                  <ActionLine key={idx} action={action} run={run} />
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
