"use client";

import { RoteirosDoContato } from "@/components/contacts/RoteirosDoContato";
import { AcervoSearch } from "./AcervoSearch";
import { LeadEnrichment } from "./LeadEnrichment";
import { AnuncioDoContato, type AnuncioDeOrigem, type AnuncioMaisRecente } from "./AnuncioDoContato";
import type { ProspectEnrichment } from "@/lib/prospecting/schema";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { roleAtLeast } from "@/lib/auth/types";
import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";

import type { Locale } from "date-fns";
import Link from "next/link";
import { useT } from "@/hooks/i18n/useT";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { format } from "date-fns";
import { ChipDeEtiqueta } from "@/components/tags/ChipDeEtiqueta";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Tag, Receipt, Users, ArrowRight, CaretDoubleLeft, CaretDoubleRight } from "@/lib/ui/icons";
import { apiClient } from "@/lib/api/client";
import { toast } from "sonner";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";
import { activityLabel, actorLabel, actorShape } from "@/lib/leads/activity-vocabulary";
import { soChavesAlteradas } from "@/lib/leads/custom-fields-so-diff";
import { ConversationTagsEditor } from "./ConversationTagsEditor";
import { ContactTagsEditor } from "./ContactTagsEditor";
import { TarefasDaDemanda } from "./TarefasDaDemanda";
import { useDefaultPipeline } from "@/hooks/pipelines/useDefaultPipeline";
import { LoseLeadDialog } from "@/components/kanban/LoseLeadDialog";
import { NewLeadDialog } from "@/components/kanban/NewLeadDialog";
import { MoveToOtherPipelineDialog } from "@/components/kanban/MoveToOtherPipelineDialog";
import { CustomFieldsEditor, type CustomFieldDef } from "@/components/contacts/CustomFieldsEditor";
import { useEditLead } from "@/hooks/kanban/useUpdateLead";
import { useBulkAction } from "@/hooks/kanban/useBulkAction";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { PROXIMO_PASSO_DA_MENSAGEM_NOVA } from "@/lib/atendimento/proximo-passo-padrao";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import { phoneForDisplay } from "@/lib/channels/phone-variants";

interface Props {
  conversation: ConversationWithContact | null;
  /**
   * O painel inteiro recolhido (issue #3004): em vez do conteúdo, desenha só o
   * trilho com o botão de expandir — e a tela (`InboxLayout`) devolve a largura
   * ao fio da conversa. São DOIS valores, um estado: `recolhido` diz como
   * desenhar, `onAlternarRecolhido` diz se há controle.
   */
  recolhido?: boolean;
  /**
   * O clique do controle. Só existe na coluna do desktop: o painel do celular
   * abre dentro de um `Sheet`, que já tem o próprio gesto de fechar — por isso o
   * controle é OPCIONAL, como o `showCollapseControl` do menu da esquerda, e o
   * `Sheet` do Inbox não o passa.
   */
  onAlternarRecolhido?: () => void;
}

interface LeadRow {
  id: string;
  title: string;
  status: string;
  value_cents: number | null;
  currency: string | null;
  updated_at: string;
  pipeline_id: string;
  custom_fields: Record<string, unknown> | null;
  field_defs: CustomFieldDef[];
  funil_nome: string | null;
  etapa_nome: string | null;
  stage_id?: string;
  /** As etapas ativas do funil, na ordem do quadro (rota crm-summary). */
  etapas_do_funil?: Array<{ id: string; name: string; is_won: boolean; is_lost: boolean }>;
  motivos_de_perda?: string[];
}

interface OrderRow {
  id: string;
  external_id: string | null;
  status: string | null;
  total_cents: number | null;
  currency: string | null;
  created_at: string;
}

interface ActivityRow {
  id: string;
  type: string;
  source_module: string;
  performed_at: string;
  payload: Record<string, unknown> | null;
  /** 0071 — o porquê legível e quem agiu. */
  reason: string | null;
  actor_kind: string | null;
  /**
   * O NOME de quem agiu. `actor_kind` responde "uma pessoa ou o agente?"; esta
   * responde "qual pessoa?" — e é a diferença entre "Transferiu a conversa ·
   * Você/time" e "Transferiu a conversa · Maria Silva", que é a pergunta que o
   * painel existe para responder. `null` é estado declarado (sem service role),
   * e aí a linha volta ao rótulo genérico.
   */
  performed_by_name?: string | null;
}

/**
 * Passo 4 do cap. 5 — a demanda no lugar onde o humano atende.
 *
 * As outras três listas contam o que já aconteceu (negócio, pedido, histórico).
 * Esta conta o que **ainda não acabou**, que é a pergunta que a pessoa do outro
 * lado está fazendo. Sem ela, o atendente encerra a conversa sem saber que a
 * demanda continua aberta e sem próximo passo — e o vazamento só reaparece
 * depois, como número numa métrica que ele não abre.
 */
interface DemandaRow {
  id: string;
  revision: number;
  aberta_em: string;
  origem: string;
  estado: string;
  proximo_passo: string | null;
  proximo_passo_em: string | null;
  prazo_em: string | null;
}

interface DesfechoDraft {
  conversationId: string;
  contactId: string;
  demandaId: string;
  revision: number;
  desfecho: string;
  salvando: boolean;
}

function EncerrarDemanda({ draft, onAbrir, onAlterar, onFechar, onPronto }: {
  draft: DesfechoDraft | null;
  onAbrir: () => void;
  onAlterar: (patch: Partial<Pick<DesfechoDraft, "desfecho" | "salvando">>) => void;
  onFechar: () => void;
  onPronto: () => void;
}) {
  const t = useT();
  if (!draft) return <Button size="sm" variant="ghost" onClick={onAbrir}>{t("Encerrar demanda")}</Button>;
  return <form className="mt-2 space-y-2" onSubmit={async (event) => {
    event.preventDefault(); onAlterar({ salvando: true });
    try {
      await apiClient.patch(`/api/v1/demandas/${draft.demandaId}`, { action: "encerrar", desfecho: draft.desfecho, expected_revision: draft.revision });
      toast.success(t("Desfecho registrado.")); onFechar(); onPronto();
    } catch { toast.error(t("Não foi possível encerrar. Cancele esta edição e abra novamente para revisar o desfecho.")); onPronto(); }
    finally { onAlterar({ salvando: false }); }
  }}>
    <label className="block">{t("Desfecho")}
      <select aria-label={t("Desfecho da demanda")} className="mt-1 w-full rounded-md border bg-background p-2" value={draft.desfecho} onChange={(e) => onAlterar({ desfecho: e.target.value })}>
        <option value="resolvida">{t("Resolvida")}</option><option value="convertida">{t("Convertida")}</option>
        <option value="nao_procede">{t("Não procede")}</option><option value="encerrada_pelo_cliente">{t("Encerrada pelo cliente")}</option>
        <option value="perdida">{t("Perdida")}</option><option value="expirada_sem_resposta">{t("Expirada sem resposta")}</option>
      </select>
    </label>
    <p>{t("Registra o resultado desta demanda. As conversas dos outros canais permanecem disponíveis.")}</p>
    <Button size="sm" disabled={draft.salvando} type="submit">{t("Confirmar desfecho")}</Button>
    <Button size="sm" variant="ghost" type="button" disabled={draft.salvando} onClick={onFechar}>{t("Cancelar")}</Button>
  </form>;
}

const DESFECHO_LEGIVEL: Record<string, string> = {
  resolvida: "Resolvida", convertida: "Convertida", nao_procede: "Não procede",
  encerrada_pelo_cliente: "Encerrada pelo cliente", perdida: "Perdida", expirada_sem_resposta: "Expirada sem resposta",
};

/** Vocabulário de quem atende, não o do banco. */
const ESTADO_LEGIVEL: Record<string, string> = {
  aberta: "Aberta",
  em_atendimento: "Em atendimento",
  aguardando_cliente: "Aguardando o cliente",
};

function horasDesde(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000));
}

/**
 * Marcar o próximo passo, no lugar onde o atendente já está.
 *
 * Fica FECHADO por padrão: a lista costuma ter mais de uma demanda, e um campo
 * de texto aberto em cada uma transformaria a seção de contexto em formulário.
 * O botão é a promessa; o campo aparece quando alguém aceita.
 *
 * Sem data de propósito nesta superfície. Obrigar hora aqui faria o atendente
 * inventar uma para se livrar do campo — e data inventada é pior que ausente,
 * porque o Radar passa a cobrar no dia errado. A rota aceita
 * `proximo_passo_em`; quem precisa de compromisso datado usa o retorno.
 */
function MarcarProximoPasso({ demandaId, onPronto }: { demandaId: string; onPronto: () => void }) {
  const t = useT();
  const [aberto, setAberto] = useState(false);
  const [texto, setTexto] = useState("");
  const [salvando, setSalvando] = useState(false);

  async function salvar() {
    const passo = texto.trim();
    if (passo.length < 3) return;
    setSalvando(true);
    try {
      await apiClient.patch(`/api/v1/demandas/${demandaId}`, { proximo_passo: passo });
      setAberto(false);
      setTexto("");
      onPronto();
    } catch {
      // Falha NÃO fecha o campo: fechar devolveria a tela ao estado de sucesso
      // e o texto se perderia sem que ninguém tivesse gravado nada.
      toast.error(t("Não consegui salvar o próximo passo. Tente de novo."));
    } finally {
      setSalvando(false);
    }
  }

  if (!aberto) {
    return (
      <Button
        size="sm"
        variant="outline"
        className="mt-1.5 h-7 text-xs"
        data-testid="marcar-proximo-passo"
        onClick={() => setAberto(true)}
      >
        {t("Marcar próximo passo")}
      </Button>
    );
  }

  return (
    <div className="mt-1.5 space-y-1.5">
      <input
        autoFocus
        value={texto}
        onChange={(e) => setTexto(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void salvar();
          if (e.key === "Escape") setAberto(false);
        }}
        maxLength={500}
        placeholder={t("O que acontece a seguir?")}
        aria-label={t("Próximo passo desta demanda")}
        data-testid="campo-proximo-passo"
        className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs focus:outline-hidden focus:ring-1 focus:ring-ring"
      />
      <div className="flex gap-1.5">
        <Button
          size="sm"
          className="h-7 text-xs"
          disabled={salvando || texto.trim().length < 3}
          data-testid="salvar-proximo-passo"
          onClick={() => void salvar()}
        >
          {salvando ? t("Salvando…") : t("Salvar")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs"
          onClick={() => setAberto(false)}
        >
          {t("Cancelar")}
        </Button>
      </div>
    </div>
  );
}

function formatMoney(cents: number | null, currency: string | null): string {
  if (cents == null) return "—";
  const cur = currency ?? "BRL";
  try {
    return new Intl.NumberFormat("pt-BR", { style: "currency", currency: cur }).format(
      cents / 100,
    );
  } catch {
    return `${(cents / 100).toFixed(2)} ${cur}`;
  }
}

function shortDate(iso: string, locale: Locale): string {
  return format(new Date(iso), "dd/MM/yy HH:mm", { locale: locale });
}

/**
 * O que cada seção mostra quando não tem lista para mostrar.
 *
 * Peça única porque são TRÊS seções tomando a MESMA decisão — e foi por essa
 * decisão viver repetida em três lugares que as três mentiam juntas.
 *
 * Fora do componente de propósito: declarada dentro do corpo, ela vira um tipo
 * novo a cada render e o React remonta a peça inteira. O linter reprovou, com
 * razão — e eu tinha notado o cheiro e seguido em frente.
 *
 * Erro sem saída também é beco, por isso o botão.
 */
function SemLista({
  vazio,
  erro,
  onTentarDeNovo,
}: {
  vazio: string;
  erro: boolean;
  onTentarDeNovo: () => void;
}) {
  const t = useT();
  if (!erro) return <p className="mt-2 text-xs text-muted-foreground">{t(vazio)}</p>;
  return (
    <div className="mt-2 space-y-1">
      <p className="text-xs text-error-fg">{t("Não consegui ler estes dados.")}</p>
      <Button size="sm" variant="outline" onClick={onTentarDeNovo}>
        {t("Tentar de novo")}
      </Button>
    </div>
  );
}

/**
 * Só os campos do funil, no lugar onde a conversa acontece.
 *
 * Título, valor e tags já têm casa no dossiê. Quem atende descobre o dado
 * customizado (CPF, plano, endereço) aqui — e tinha de ir no Kanban gravar.
 */
/**
 * O banco guarda `open`/`won`/`lost`; a tela mostrava a palavra crua (#943).
 *
 * ⚠️ NÃO troque "Ganho"/"Perdido" por `crm_pipelines.vocabulary` sem antes
 * mudar o que essa coluna guarda. O DEFAULT dela é o de e-commerce (`won:
 * Pago`, `lost: Cancelado`, supabase/baseline.sql) e nenhum caminho normal a
 * reescreve: o onboarding troca só as ETAPAS pelo quadro do ramo
 * (`fn_aplicar_quadro_do_onboarding` atualiza nome e slug do funil), e
 * `POST /api/v1/pipelines` não a preenche — quem escreve é só a tela Etapas do
 * funil, à mão. Lida daqui, ela faria uma clínica recém-instalada ver "Pago"
 * ao lado de "Consulta marcada". Guardado em
 * tests/unit/inbox-leads-recentes-com-funil.test.tsx.
 */
const STATUS_DO_LEAD: Record<string, string> = { open: "Aberto", won: "Ganho", lost: "Perdido" };

/** "Funil · Etapa" — sem isto dois leads de mesmo título ficam idênticos (#943). */
function ondeEstaOLead(l: LeadRow): string {
  return [l.funil_nome, l.etapa_nome].filter(Boolean).join(" · ");
}

/**
 * `line-clamp-2`, não `truncate` — e a diferença não depende de medir pixel.
 *
 * `truncate` corta numa linha só, e corte de texto some pela DIREITA: a metade
 * perdida é sempre a ETAPA, que é justamente a que diz onde o negócio está.
 * "Funil de Vendas Consultivas B2B · Proposta enviada" nesta coluna de 296px
 * viraria "Funil de Vendas Consul…" — o operador lê o funil, que ele já sabia,
 * e perde a etapa, que é o dado novo. A medida por ferramenta diria a partir de
 * QUE largura isso acontece; não muda QUAL metade morre, que é o defeito.
 *
 * Duas linhas dobram o orçamento sem mexer no texto (mesmo uso que
 * `Composer.tsx:259` e `MessageBubble.tsx:193` já fazem), e o `title` devolve a
 * frase inteira no hover para o resto — com o nome do funil cortado não há
 * outro lugar na tela onde lê-lo.
 *
 * ⚠️ NÃO medido: a largura em que a segunda linha também estoura, e o
 * comportamento em tela de celular (onde não há hover). Fica para quem rodar a
 * spec de tela com `getBoundingClientRect`.
 */
const CLASSES_DE_ONDE_ESTA = "line-clamp-2 text-muted-foreground";

function InboxLeadEditor({
  leads,
  selecionadoId,
  onSelecionar,
  onSalvo,
  podeLevarParaOutroFunil,
  onTrocouDeNegocio,
}: {
  leads: LeadRow[];
  selecionadoId: string | null;
  onSelecionar: (id: string) => void;
  onSalvo: () => void;
  /** Mesmo portão do Kanban (`pipeline.move_card`) — ver `LevarParaOutroFunil`. */
  podeLevarParaOutroFunil: boolean;
  /** Recarrega o resumo e deixa o negócio NOVO (se algum nasceu) virar o ativo. */
  onTrocouDeNegocio: () => void;
}) {
  const t = useT();
  const ativo = leads.find((l) => l.id === selecionadoId) ?? leads[0]!;
  const status = (l: LeadRow) => t(STATUS_DO_LEAD[l.status] ?? l.status);

  return (
    <div className="mt-2 space-y-2">
      {leads.length > 1 && (
        <ul className="space-y-1">
          {leads.map((l) => {
            const marcado = l.id === ativo.id;
            return (
              <li key={l.id}>
                <button
                  type="button"
                  data-testid={`inbox-lead-${l.id}`}
                  aria-pressed={marcado}
                  onClick={() => onSelecionar(l.id)}
                  className={cn(
                    "w-full rounded-md border p-2 text-left text-xs",
                    marcado ? "border-accent bg-accent/10" : "border-border",
                  )}
                >
                  <div className="truncate font-medium">{l.title}</div>
                  <div className={CLASSES_DE_ONDE_ESTA} title={ondeEstaOLead(l)}>
                    {ondeEstaOLead(l)}
                  </div>
                  <div className="text-muted-foreground">
                    {status(l)} · {formatMoney(l.value_cents, l.currency)}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {leads.length === 1 && (
        <div data-testid="inbox-lead-unico" className="text-xs text-muted-foreground">
          <p>{ativo.title} · {status(ativo)}</p>
          <p className={CLASSES_DE_ONDE_ESTA} title={ondeEstaOLead(ativo)}>
            {ondeEstaOLead(ativo)}
          </p>
        </div>
      )}
      <EtapaDoNegocio key={`etapa-${ativo.id}`} lead={ativo} onMovido={onSalvo} />
      {/*
        ABRIR O NEGÓCIO NO QUADRO DO FUNIL (issue #3004).

        Antes, ir do atendimento ao card exigia sair do Inbox, abrir o quadro e
        procurar o negócio na mão — trabalho que o próprio sistema já sabia fazer:
        a rota do funil entende `?lead=`, o MESMO parâmetro que
        `app/app/leads/[id]/page.tsx` já usa para jogar quem chega pela captação
        direto no negócio (`KanbanBoard.leadInicial` abre o dossiê do card). Aqui
        só se reusa essa âncora com o `pipeline_id` do negócio ativo — nada novo
        de rota, nada de quadro reimplementado.
      */}
      <Button asChild size="sm" variant="outline" className="h-7 w-full text-xs">
        <Link
          href={`/app/pipelines/${ativo.pipeline_id}?lead=${ativo.id}`}
          data-testid="inbox-abrir-no-funil"
        >
          <ArrowRight size={12} className="mr-1" weight="regular" aria-hidden />
          {t("Abrir no funil")}
        </Link>
      </Button>
      <LevarParaOutroFunil
        key={`levar-${ativo.id}`}
        lead={ativo}
        podeLevar={podeLevarParaOutroFunil}
        onTrocouDeNegocio={onTrocouDeNegocio}
      />
      <CamposDoFunil
        key={ativo.id}
        leadId={ativo.id}
        pipelineId={ativo.pipeline_id}
        fieldDefs={ativo.field_defs ?? []}
        valores={ativo.custom_fields ?? {}}
        onSalvo={onSalvo}
      />
    </div>
  );
}

/**
 * Mover o negócio de etapa SEM sair da conversa — ex.: passar a "Pedido
 * confirmado" quando o cliente confirma pelo WhatsApp. Antes só dava pelo quadro
 * do funil: quem atendia tinha de sair da conversa, achar o card e arrastá-lo.
 *
 * Usa o MESMO caminho do "Mover para…" do quadro (`/api/v1/leads/bulk`, que
 * posiciona o card no banco e emite atividade, evento e auditoria), então a
 * etapa que avisa na Central avisa igual. A etapa de PERDA aparece também, mas
 * não move direto: ela pede o motivo, então abre o mesmo `LoseLeadDialog` do
 * quadro (issue #2871).
 */
function EtapaDoNegocio({ lead, onMovido }: { lead: LeadRow; onMovido: () => void }) {
  const t = useT();
  const mover = useBulkAction(lead.pipeline_id);
  const [perdendo, setPerdendo] = useState(false);
  const etapas = lead.etapas_do_funil ?? [];
  if (!lead.stage_id || etapas.length === 0) return null;

  async function escolher(stageId: string) {
    if (stageId === lead.stage_id) return;
    if (etapas.find((e) => e.id === stageId)?.is_lost) {
      setPerdendo(true);
      return;
    }
    try {
      await mover.mutateAsync({ action: "move", lead_ids: [lead.id], params: { stage_id: stageId } });
      toast.success(t("Etapa atualizada."));
      onMovido();
    } catch {
      // o hook já mostrou o erro
    }
  }

  return (
    <div className="space-y-1" data-testid="inbox-etapa-do-negocio">
      <label className="block text-xs font-medium text-text" htmlFor={`etapa-${lead.id}`}>
        {t("Etapa do funil")}
      </label>
      <Select value={lead.stage_id} onValueChange={(v) => void escolher(v)} disabled={mover.isPending}>
        <SelectTrigger id={`etapa-${lead.id}`} className="h-8 w-full text-xs" data-testid="inbox-etapa-select">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {etapas.map((e) => (
            <SelectItem key={e.id} value={e.id} className="text-xs">
              {e.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <LoseLeadDialog
        open={perdendo}
        onOpenChange={setPerdendo}
        leadId={lead.id}
        pipelineId={lead.pipeline_id}
        onPerdido={onMovido}
        motivos={lead.motivos_de_perda}
      />
    </div>
  );
}

/**
 * "Levar para outro funil" no lead ATIVO da conversa — o que faltava ao lado de
 * "Etapa do funil". Antes, mudar de funil exigia sair, abrir o Kanban, achar o
 * card e usar a mesma ação lá.
 *
 * Nada de transferência é reimplementado aqui: abre o MESMO diálogo do quadro
 * (`components/kanban/MoveToOtherPipelineDialog`, o que `KanbanCardActions`
 * usa), que por sua vez reusa `useMoveLeadToPipeline` / `useDestinosDeFunil` e a
 * rota `POST /api/v1/leads/[id]/clone` — a rota cria o negócio no funil destino
 * (primeira etapa aberta) e encerra a origem com o motivo canônico.
 *
 * O portão é o do Kanban: `pipeline.move_card` (agent+) — a MESMA chave de
 * `usePermission` em `KanbanCardActions` e o mesmo piso que `POST /clone` exige
 * (`requireRole("agent")`). Aqui a régua entra escrita como `roleAtLeast` porque
 * este painel já resolve `podeCriarTarefa` assim (o `usePermission` não sobrevive
 * aos dublês de `useAuth` dos testes do painel); a semântica é idêntica — floor
 * `agent` mais o atalho do platform admin. Mostrar a ação a quem o servidor
 * recusaria seria prometer o que não se cumpre.
 *
 * O erro sai como toast pelo `onError` do hook (o próprio `showApiError` do
 * quadro, em `ApiErrorToast`), e o diálogo fica ABERTO para o operador ler e
 * corrigir — igual ao card.
 */
function LevarParaOutroFunil({
  lead,
  podeLevar,
  onTrocouDeNegocio,
}: {
  lead: LeadRow;
  podeLevar: boolean;
  onTrocouDeNegocio: () => void;
}) {
  const t = useT();
  const [aberto, setAberto] = useState(false);
  if (!podeLevar) return null;

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-7 w-full text-xs"
        data-testid="inbox-levar-para-outro-funil"
        onClick={() => setAberto(true)}
      >
        {t("Levar para outro funil")}
      </Button>
      <MoveToOtherPipelineDialog
        open={aberto}
        onOpenChange={(next) => {
          setAberto(next);
          // Fechar — confirmar OU cancelar — relê o resumo: quem decide se a
          // seleção muda é o diff de ids em `load`, não este evento. Assim um
          // cancelamento não troca o negócio ativo por engano.
          if (!next) onTrocouDeNegocio();
        }}
        leadId={lead.id}
        pipelineId={lead.pipeline_id}
      />
    </>
  );
}

function CamposDoFunil({
  leadId,
  pipelineId,
  fieldDefs,
  valores,
  onSalvo,
}: {
  leadId: string;
  pipelineId: string;
  fieldDefs: CustomFieldDef[];
  valores: Record<string, unknown>;
  onSalvo: () => void;
}) {
  const t = useT();
  const edit = useEditLead(pipelineId);
  const [customFields, setCustomFields] = useState(valores);
  // A RÉGUA do diff (issue #2132): o valor carregado quando o painel abriu.
  // Só o que a pessoa mudar daqui vai viajar — o merge é do servidor.
  const [camposCarregados, setCamposCarregados] = useState(valores);

  if (fieldDefs.length === 0) {
    return <p className="text-xs text-muted-foreground">{t("Este funil não tem campos extras.")}</p>;
  }

  async function salvar() {
    const payload = soChavesAlteradas(camposCarregados, customFields);
    try {
      await edit.mutateAsync({ leadId, patch: { custom_fields: payload } });
      // O que acabou de gravar vira a nova régua: o próximo salvamento não
      // reenvia este, e uma limpeza alheia no intervalo não é atropelada.
      setCamposCarregados({ ...customFields });
      toast.success(t("Campos atualizados"));
      onSalvo();
    } catch {
      // toast already shown
    }
  }

  return (
    <div className="space-y-3">
      <CustomFieldsEditor
        fields={fieldDefs}
        value={customFields}
        onChange={setCustomFields}
        mode="lead"
        className="gap-3 md:grid-cols-1"
      />
      <Button
        size="sm"
        className="h-7 w-full text-xs"
        disabled={edit.isPending}
        onClick={() => void salvar()}
      >
        {edit.isPending ? "Salvando…" : "Salvar"}
      </Button>
    </div>
  );
}

/**
 * O CONTROLE DE RECOLHER O PAINEL INTEIRO (issue #3004).
 *
 * Mesmo ícone e mesmo vocabulário do recolher do menu da esquerda
 * (`BotaoDeRecolher` em `components/shell/Sidebar.tsx`): `CaretDoubleLeft` para
 * recolher, `CaretDoubleRight` para expandir, o verbo "Recolher"/"Expandir" no
 * rótulo. O que muda é o ALVO na frase: aqui há dois recolhedores na mesma tela,
 * e um leitor de tela que ouvisse "Recolher" nos dois não saberia qual. O
 * alvo explícito ("painel do contato") é o que os distingue — o vocabulário
 * continua o mesmo.
 *
 * É `Link`/botão próprio e não o `Button` do design system porque o recolher da
 * esquerda também não é: é um controle de casca, discreto (`text-muted-foreground`
 * até o hover), que não compete com as ações do contato.
 */
function BotaoDeRecolherDoPainel({
  recolhido,
  onAlternar,
}: {
  recolhido: boolean;
  onAlternar: () => void;
}) {
  const t = useT();
  // Um rótulo só para `aria-label` e `title`: os dois nomeiam a MESMA ação.
  const rotulo = recolhido ? t("Expandir painel do contato") : t("Recolher painel do contato");
  return (
    <button
      type="button"
      onClick={onAlternar}
      // Vocabulário e ícone iguais aos do menu da esquerda (`BotaoDeRecolher`).
      className={cn(
        "flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground",
        recolhido && "justify-center",
      )}
      aria-label={rotulo}
      aria-expanded={!recolhido}
      title={rotulo}
      data-testid="inbox-recolher-painel"
    >
      {recolhido ? (
        <CaretDoubleRight size={14} aria-hidden />
      ) : (
        <CaretDoubleLeft size={14} aria-hidden />
      )}
      {!recolhido && <span>{t("Recolher")}</span>}
    </button>
  );
}

export function CRMSidePanel({ conversation, recolhido = false, onAlternarRecolhido }: Props) {
  const { user, activeOrg } = useAuth();
  const readonly = user.support?.access_mode === "support_readonly";
  // Criar tarefa é `agent`+ (a rota cobra `requireRole("agent")`): a MESMA régua
  // da tela de Tarefas (`app/app/tasks/page.tsx`). `readonly` sozinho deixava o
  // `viewer` ver "Nova tarefa", preencher e levar 403 ao salvar (#2842).
  const podeCriarTarefa = (user.is_platform_admin && !user.support) || roleAtLeast(activeOrg?.role, "agent");
  // A MESMA régua do Kanban para "Levar para outro funil": `pipeline.move_card`
  // (agent+) é a chave que `KanbanCardActions` consulta e o piso que
  // `POST /api/v1/leads/[id]/clone` cobra no servidor. Escrita como `roleAtLeast`
  // pelo mesmo motivo de `podeCriarTarefa` acima — os dublês de `useAuth` dos
  // testes deste painel não expõem `usePermission`, e a semântica é a mesma.
  const podeLevarParaOutroFunil = (user.is_platform_admin && !user.support) || roleAtLeast(activeOrg?.role, "agent");
  const localeDaData = useLocaleDeData();
  const t = useT();
  const contact = conversation?.contacts ?? null;
  const contactId = contact?.id ?? null;
  const [desfechoDraft, setDesfechoDraft] = useState<DesfechoDraft | null>(null);
  // A saída do filtro produz null enquanto o detalhe carrega. O rascunho não
  // some nessa lacuna; outra conversa/contato real o descarta, sem expô-lo.
  useEffect(() => {
    if (conversation && desfechoDraft && (conversation.id !== desfechoDraft.conversationId || contactId !== desfechoDraft.contactId)) setDesfechoDraft(null);
  }, [conversation, contactId, desfechoDraft]);


  const [enrichment, setEnrichment] = useState<(ProspectEnrichment & { collected_at: string }) | null>(null);
  const [enrichmentError, setEnrichmentError] = useState(false);
  const [leads, setLeads] = useState<LeadRow[] | null>(null);
  const [orders, setOrders] = useState<OrderRow[] | null>(null);
  const [activities, setActivities] = useState<ActivityRow[] | null>(null);
  const [demandas, setDemandas] = useState<DemandaRow[] | null>(null);
  const [fatos, setFatos] = useState<Array<{ id: string; headline: string; body: string }>>([]);
  const [historico, setHistorico] = useState<Array<{ id: string; desfecho: string; fechada_em: string }>>([]);
  const [anuncios, setAnuncios] = useState<{ origem: AnuncioDeOrigem | null; recente: AnuncioMaisRecente | null }>({ origem: null, recente: null });
  const [summaryContactId, setSummaryContactId] = useState<string | null>(null);
  /**
   * O TERCEIRO ESTADO. Antes existiam dois — carregando e "tem N itens" — e a
   * falha era traduzida para lista vazia, virando "Sem leads.": uma afirmação
   * sobre o NEGÓCIO feita em cima de um erro de leitura. Distinguir "não tem"
   * de "não consegui ler" é a diferença entre informar e mentir.
   */
  const [erro, setErro] = useState(false);
  const [tentativa, setTentativa] = useState(0);
  /**
   * Os ids de negócio da ÚLTIMA leitura — a régua para achar o negócio NOVO de
   * uma troca de funil (ver `load`). `procurarNovoNegocio` só liga quando o
   * diálogo "Levar para outro funil" fecha, para o diff não mexer na seleção
   * fora de uma troca.
   */
  const idsDeNegocioVistos = useRef<Set<string>>(new Set());
  const procurarNovoNegocio = useRef(false);

  const [tagEditorOpen, setTagEditorOpen] = useState(false);
  const [leadDialogOpen, setLeadDialogOpen] = useState(false);
  const [leadAtivoId, setLeadAtivoId] = useState<string | null>(null);
  const defaultPipeline = useDefaultPipeline(leadDialogOpen);

  useEffect(() => {
    if (leadDialogOpen && defaultPipeline.isError) {
      toast.error(t("Nenhum funil configurado nesta organização."));
      setLeadDialogOpen(false);
    }
  }, [leadDialogOpen, defaultPipeline.isError, t]);

  useEffect(() => {
    if (!contactId) {
      setLeads(null);
      setOrders(null);
      setActivities(null);
      setDemandas(null);
      setFatos([]); setHistorico([]);
      setAnuncios({ origem: null, recente: null });
      setLeadAtivoId(null);
      idsDeNegocioVistos.current.clear();
      procurarNovoNegocio.current = false;
      return;
    }
    let cancelled = false;

    setErro(false);

    // Pela ROTA, não pelo cliente de navegador: o cookie de sessão é httpOnly,
    // então o supabase-js do browser não vê a sessão e consultava como `anon`
    // (medido: role=anon com gerente logado). Ver o cabeçalho da rota.
    async function load() {
      try {
        const r = await apiClient.get<{
          data: {
            enrichment?: (ProspectEnrichment & { collected_at: string }) | null;
            enrichment_error?: boolean;
            leads: LeadRow[];
            orders: OrderRow[];
            activities: ActivityRow[];
            demandas: DemandaRow[];
            fatos?: Array<{ id: string; headline: string; body: string }>;
            historico?: Array<{ id: string; desfecho: string; fechada_em: string }>;
            anuncio_de_origem?: AnuncioDeOrigem | null;
            anuncio_mais_recente?: AnuncioMaisRecente | null;
          };
        }>(`/api/v1/contacts/${contactId}/crm-summary`);
        if (cancelled) return;
        setSummaryContactId(contactId);
        setEnrichment(r.data.enrichment ?? null);
        setEnrichmentError(r.data.enrichment_error ?? false);
        setLeads(r.data.leads);
        // A TROCA DE FUNIL cria um negócio que ESTE painel nunca viu, e o
        // diálogo reusado do Kanban não devolve o id dele. O negócio novo é o
        // que não estava na leitura anterior — e é ele que passa a ser o ATIVO,
        // como a issue pede. Um cancelamento (nada novo no resumo) não mexe na
        // seleção: o diff simplesmente não acha id novo.
        const idsAgora = new Set(r.data.leads.map((l) => l.id));
        if (procurarNovoNegocio.current) {
          const novo = r.data.leads.find((l) => !idsDeNegocioVistos.current.has(l.id));
          procurarNovoNegocio.current = false;
          if (novo) setLeadAtivoId(novo.id);
        }
        idsDeNegocioVistos.current = idsAgora;
        setOrders(r.data.orders);
        setActivities(r.data.activities);
        // `?? []` e não `?? null`: aqui a leitura DEU CERTO. Cair em `null`
        // faria a lista vazia se disfarçar do terceiro estado e o painel
        // mostraria esqueleto para sempre num contato sem demanda aberta —
        // que é o caso saudável.
        setDemandas(r.data.demandas ?? []);
        setFatos(r.data.fatos ?? []); setHistorico(r.data.historico ?? []);
        setAnuncios({ origem: r.data.anuncio_de_origem ?? null, recente: r.data.anuncio_mais_recente ?? null });
      } catch {
        if (cancelled) return;
        // Falha NÃO vira lista vazia. Os dados ficam `null` e o painel diz que
        // não conseguiu ler — nunca que não há.
        setErro(true);
        setLeads(null);
        setOrders(null);
        setActivities(null);
        setDemandas(null);
        setFatos([]); setHistorico([]);
        setAnuncios({ origem: null, recente: null });
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
    // AS DUAS DEPS NOVAS SÃO O REFETCH DA TROCA DE COMANDO.
    //
    // Este painel não usa react-query: ele busca num `useEffect` e guarda em
    // `useState`, então `invalidateQueries` não o alcança — e os hooks de
    // claim/transfer/release/pausar invalidam só as chaves de conversa. Resultado
    // medido: as quatro atividades novas ("Assumiu a conversa" e irmãs) nasciam no
    // banco e a seção "Atividade" ao lado NUNCA as mostrava, porque `contactId` não
    // muda quando o dono muda e o painel fica montado o tempo todo.
    //
    // Depender do DADO que muda é mais honesto que um contador de invalidação:
    // `assigned_to_user_id` cobre assumir/transferir/liberar e `bot_silenced_until`
    // cobre pausar e devolver — que são exatamente os quatro gestos que geram linha.
  }, [contactId, contact?.is_anonymized, tentativa, conversation?.assigned_to_user_id, conversation?.bot_silenced_until, conversation?.service_revision, conversation?.current_demanda_id]);

  // Recarrega o resumo pelo MESMO caminho do "Tentar de novo": o efeito depende
  // de `tentativa`, então a demanda recém-marcada volta do servidor em vez de
  // ser apagada da lista no cliente. Sumir no otimismo esconderia uma escrita
  // que falhou depois — e escrita que parece ter dado certo é o defeito que
  // esta tela inteira combate.
  const recarregar = useCallback(() => setTentativa((n) => n + 1), []);

  /**
   * A troca de funil recarrega pelo MESMO caminho do "Tentar de novo" — este
   * painel não usa react-query, então `invalidateQueries` não o alcança — e
   * marca que um negócio novo pode ter nascido: `load` o elege como ativo.
   */
  const aoTrocarDeNegocio = useCallback(() => {
    procurarNovoNegocio.current = true;
    setTentativa((n) => n + 1);
  }, []);

  const tags = contact?.tags ?? [];
  const displayName = rotuloDoContato(contact, t);

  // `erro` PRIMEIRO, e não é detalhe: as três listas voltam a `null` quando a
  // leitura falha, e este derivado lê `null` como "ainda não chegou". Sem esta
  // guarda o painel mostraria esqueleto para sempre e o estado de falha nunca
  // apareceria — o mesmo colapso de significados que criou o defeito original,
  // só que trocando "erro→vazio" por "erro→carregando".
  const sectionsLoading = useMemo(
    () =>
      !erro &&
      (summaryContactId !== contactId || (leads === null && orders === null && activities === null && demandas === null)),
    [erro, summaryContactId, contactId, leads, orders, activities, demandas],
  );

  /**
   * O negócio ATIVO do contato, se houver: a tarefa criada no inbox também o
   * aponta (#2818). `leadAtivoId` é o que o editor de leads marcou (o contato
   * pode ter vários negócios); sem escolha, o primeiro da lista, que é o que
   * `InboxLeadEditor` mostra como ativo.
   */
  const negocioAtivoId = leadAtivoId ?? leads?.[0]?.id ?? null;

  /**
   * RECOLHIDO (issue #3004): só o trilho, com o botão de expandir. Sem o
   * controle — o caso do `Sheet` do celular — o trilho não teria porta de volta,
   * então nesse caso o painel desenha inteiro, como sempre desenhou.
   */
  if (recolhido && onAlternarRecolhido) {
    return (
      <aside
        className="flex h-full flex-col items-center border-l border-border bg-background py-2"
        data-testid="inbox-painel-recolhido"
      >
        <BotaoDeRecolherDoPainel recolhido onAlternar={onAlternarRecolhido} />
      </aside>
    );
  }

  if (!conversation) {
    return (
      <aside className="relative flex h-full items-center justify-center border-l border-border p-4 text-center text-xs text-muted-foreground">
        {onAlternarRecolhido && (
          <div className="absolute top-2 right-2">
            <BotaoDeRecolherDoPainel recolhido={false} onAlternar={onAlternarRecolhido} />
          </div>
        )}
        {t("Selecione uma conversa para ver detalhes do contato.")}
      </aside>
    );
  }

  return (
    <aside className="flex h-full flex-col gap-4 overflow-y-auto border-l border-border bg-background p-4">
      {/*
        O CONTROLE DE RECOLHER, NO ALTO (issue #3004) — mesmo lugar do recolher
        do menu da esquerda. `sticky` para não rolar para fora com o conteúdo, e
        o `-mx-4 -mt-4` esticam a faixa até as bordas do painel cancelando o
        padding do `<aside>`, para o controle encostar no alto sem empurrar a
        primeira seção. Sem `onAlternarRecolhido` (o `Sheet` do celular) não
        desenha nada: quem já tem o gesto de fechar não precisa deste.
      */}
      {onAlternarRecolhido && (
        <div className="sticky top-0 z-10 -mx-4 -mt-4 flex shrink-0 justify-end border-b border-border bg-background px-4 py-1">
          <BotaoDeRecolherDoPainel recolhido={false} onAlternar={onAlternarRecolhido} />
        </div>
      )}
      <section>
        <h3 className="text-xs font-semibold text-text">
          {t("Contato")}
        </h3>
        <Card className="mt-2 space-y-2 p-3 text-sm">
          <div className="font-medium">{displayName}</div>
          {contact?.phone_number && (
            <div className="text-xs text-muted-foreground">{phoneForDisplay(contact.phone_number)}</div>
          )}
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {tags.map((t) => (
                <ChipDeEtiqueta key={t} tag={t} className="h-4 px-1.5 text-[10px]" />
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-2 pt-1">
            {contactId&&conversation?<Link className="underline" href={`/app/agenda?contato=${contactId}&conversa=${conversation.id}`}>{t("Marcar compromisso")}</Link>:null}
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              disabled={readonly || !contactId}
              aria-pressed={tagEditorOpen}
              onClick={() => setTagEditorOpen((v) => !v)}
            >
              <Tag size={12} className="mr-1" weight="regular" aria-hidden /> {t("Tags do contato")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              disabled={readonly || !contactId || (leadDialogOpen && defaultPipeline.isLoading)}
              onClick={() => setLeadDialogOpen(true)}
            >
              <Users size={12} className="mr-1" weight="regular" aria-hidden />
              {leadDialogOpen && defaultPipeline.isLoading ? t("Carregando…") : t("Novo Lead")}
            </Button>
            {contactId && (
              <Button asChild size="sm" variant="ghost" className="h-7 px-2 text-xs">
                <Link href={`/app/contacts/${contactId}`}>
                  {t("Ver contato")}
                  <ArrowRight size={12} className="ml-1" weight="regular" aria-hidden />
                </Link>
              </Button>
            )}
          </div>
          {tagEditorOpen && contactId && (
            // Contexto de PESSOA: a etiqueta vai para `contacts.tags` (#2979).
            <ContactTagsEditor entityId={contactId} orgId={conversation.organization_id} tags={tags} />
          )}
        </Card>
      </section>

      {contactId && summaryContactId === contactId && !erro && (
        <AnuncioDoContato contactId={contactId} origem={anuncios.origem} recente={anuncios.recente} />
      )}

      <LeadEnrichment
        data={summaryContactId === contactId && !erro && !contact?.is_anonymized ? enrichment : null}
        loading={sectionsLoading}
        error={erro || (summaryContactId === contactId && enrichmentError)}
        onRetry={recarregar}
      />

      {contactId && defaultPipeline.data && (
        <NewLeadDialog
          open={leadDialogOpen}
          onOpenChange={setLeadDialogOpen}
          pipelineId={defaultPipeline.data.pipeline.id}
          stages={defaultPipeline.data.stages}
          contactId={contactId}
          onCreated={() => {
            setLeadAtivoId(null);
            recarregar();
          }}
        />
      )}

      <Separator />

      {!readonly && <ConversationTagsEditor
        conversationId={conversation.id}
        orgId={conversation.organization_id}
        tags={conversation.tags ?? []}
      />}

      <Separator />

      {/* ANTES dos negócios de propósito (doutrina cap. 5): lead é o negócio,
          conversa é o canal, demanda é o que precisa acabar. Quem abre esta
          conversa está atendendo alguém que pediu alguma coisa — a primeira
          pergunta a responder é o que ainda está pendente, não quanto vale. */}
      <section data-testid="inbox-demandas">
        <h3 className="text-xs font-semibold text-text">
          {t("Demandas abertas")}
        </h3>
        {sectionsLoading ? (
          <Skeleton className="mt-2 h-14 w-full" />
        ) : demandas && demandas.length > 0 ? (
          <ul className="mt-2 space-y-1.5">
            {demandas.map((d) => {
              const semPasso = !d.proximo_passo;
              return (
                <li
                  key={d.id}
                  data-testid={semPasso ? "demanda-sem-proximo-passo" : "demanda-com-proximo-passo"}
                  className={cn(
                    "rounded-md border p-2 text-xs",
                    semPasso ? "border-warning-border bg-warning-bg/40" : "border-border",
                  )}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate font-medium">
                      {t(ESTADO_LEGIVEL[d.estado] ?? d.estado)}
                    </span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {t("há {tempo}").replace("{tempo}", `${horasDesde(d.aberta_em)}h`)}
                    </span>
                  </div>
                  {/* O invariante 4 na frase, não só na cor: quem enxerga mal
                      cor precisa ler a mesma informação. */}
                  <div className={cn("mt-0.5", semPasso ? "font-medium" : "text-muted-foreground")}>
                    {d.proximo_passo === PROXIMO_PASSO_DA_MENSAGEM_NOVA
                      ? t("Responder à nova mensagem do cliente")
                      : (d.proximo_passo ?? t("Sem próximo passo definido"))}
                  </div>
                  {/* A SAÍDA. Sem ela esta seção só denunciava: o atendente via o
                      vazamento e tinha de sair da tela para resolver — peça que
                      só recebe é ilha pelo invariante 1, e foi o gate dos mapas
                      de arquitetura que apontou isso. */}
                  {d.id === conversation.current_demanda_id && <Badge variant="outline">{t("Demanda vigente neste canal")}</Badge>}
                  {!readonly && <EncerrarDemanda
                    draft={desfechoDraft?.conversationId === conversation.id && desfechoDraft.contactId === contactId && desfechoDraft.demandaId === d.id ? desfechoDraft : null}
                    onAbrir={() => { if (contactId) setDesfechoDraft({ conversationId: conversation.id, contactId, demandaId: d.id, revision: d.revision, desfecho: "resolvida", salvando: false }); }}
                    onAlterar={(patch) => setDesfechoDraft((current) => current?.conversationId === conversation.id && current.contactId === contactId && current.demandaId === d.id ? { ...current, ...patch } : current)}
                    onFechar={() => setDesfechoDraft((current) => current?.conversationId === conversation.id && current.contactId === contactId && current.demandaId === d.id ? null : current)}
                    onPronto={recarregar}
                  />}
                  {semPasso && !readonly ? <MarcarProximoPasso demandaId={d.id} onPronto={recarregar} /> : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <SemLista
            vazio="Nenhuma demanda aberta."
            erro={erro}
            onTentarDeNovo={() => setTentativa((n) => n + 1)}
          />
        )}
      </section>

      {/* A TAREFA DO ATENDIMENTO (#2818): o combinado que o atendente faz no
          meio da conversa deixa de morrer em nota de texto e ganha prazo,
          responsável e situação — sem sair da tela. Fica logo DEPOIS da
          demanda porque é dela que a tarefa pende: a seção só se desenha com
          demanda vigente no canal — e traz o PRÓPRIO divisor, que por isso não
          é escrito aqui (sem demanda, o divisor ficaria órfão e dois traços
          ficariam em pé seguidos). */}
      {/* Só a demanda vigente AINDA ABERTA: `current_demanda_id` continua
          apontando a demanda depois de "Encerrar demanda", e a seção ficaria
          oferecendo "Nova tarefa" ao lado de "Nenhuma demanda aberta" (#2842).
          A régua de aberta é a da lista acima (`fechada_em is null`, na rota).
          ponytail: a lista traz até 5 abertas; vigente fora delas não mostra a seção. */}
      <TarefasDaDemanda
        demandaId={demandas?.find((d) => d.id === conversation.current_demanda_id)?.id ?? null}
        contactId={contactId}
        leadId={negocioAtivoId}
        podeEditar={podeCriarTarefa}
      />

      <Separator />

      <section data-testid="inbox-memoria">
        <h3 className="text-xs font-semibold">{t("Memória do contato")}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{t("Fatos duráveis registrados nas notas. Pendências pertencem à demanda vigente.")}</p>
        {!sectionsLoading && fatos.map((f) => <details key={f.id} className="mt-2 text-xs"><summary className="wrap-anywhere">{f.headline}</summary><p className="mt-1 whitespace-pre-wrap wrap-anywhere">{f.body}</p></details>)}
        {!sectionsLoading && fatos.length === 0 && <p className="mt-2 text-xs text-muted-foreground">{t("Nenhum fato durável registrado.")}</p>}
        {!sectionsLoading && historico.length > 0 && <div className="mt-3 text-xs"><h4>{t("Histórico encerrado — sem tarefas pendentes")}</h4>{historico.map((h) => <p key={h.id}>{t(DESFECHO_LEGIVEL[h.desfecho] ?? h.desfecho)}{h.fechada_em ? ` · ${shortDate(h.fechada_em, localeDaData)}` : ""}</p>)}</div>}
      </section>
      <Separator />

      {/* O que os roteiros de atendimento coletaram (módulo opcional; desligado
          ou sem roteiro, não desenha nada). */}
      {contactId && !contact?.is_anonymized && <RoteirosDoContato contactId={contactId} variante="painel" />}

      <section data-testid="inbox-campos-lead">
        <h3 className="text-xs font-semibold text-text">
          {t("Leads recentes")}
        </h3>
        {sectionsLoading ? (
          <Skeleton className="mt-2 h-14 w-full" />
        ) : leads && leads.length > 0 ? (
          <fieldset disabled={readonly}><InboxLeadEditor
            leads={leads}
            selecionadoId={leadAtivoId}
            onSelecionar={setLeadAtivoId}
            onSalvo={recarregar}
            podeLevarParaOutroFunil={podeLevarParaOutroFunil}
            onTrocouDeNegocio={aoTrocarDeNegocio}
          /></fieldset>
        ) : (
          <SemLista vazio="Sem leads." erro={erro} onTentarDeNovo={() => setTentativa((n) => n + 1)} />
        )}
      </section>

      <Separator />

      <section>
        <h3 className="text-xs font-semibold text-text">
          {t("Pedidos recentes")}
        </h3>
        {sectionsLoading ? (
          <Skeleton className="mt-2 h-14 w-full" />
        ) : orders && orders.length > 0 ? (
          <ul className="mt-2 space-y-1.5">
            {orders.map((o) => (
              <li
                key={o.id}
                className="flex items-center justify-between rounded-md border border-border p-2 text-xs"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-1 truncate font-medium">
                    <Receipt size={11} weight="regular" aria-hidden />
                    {o.external_id ?? o.id.slice(0, 8)}
                  </div>
                  <div className="text-muted-foreground">
                    {o.status ?? "—"} · {formatMoney(o.total_cents, o.currency)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <SemLista vazio="Sem pedidos." erro={erro} onTentarDeNovo={() => setTentativa((n) => n + 1)} />
        )}
      </section>

      <Separator />

      <section>
        <h3 className="text-xs font-semibold text-text">
          {t("Atividade")}
        </h3>
        {sectionsLoading ? (
          <Skeleton className="mt-2 h-14 w-full" />
        ) : activities && activities.length > 0 ? (
          <ul className="mt-2 space-y-1.5">
            {activities.map((a) => (
              <li key={a.id} className="rounded-md border border-border p-2 text-xs">
                {/* Rótulo do vocabulário único (activity-vocabulary), nunca o
                    tipo cru: a tela e o banco divergiram justamente por manter
                    duas listas. Marcador por ator, forma e não cor (§5). */}
                <div className="flex items-center gap-1.5 font-medium">
                  <span
                    className={cn(
                      "h-2 w-2 shrink-0",
                      actorShape(a.actor_kind) === "filled" && "rounded-full bg-accent",
                      actorShape(a.actor_kind) === "ring" &&
                        "rounded-full border border-accent bg-surface",
                      actorShape(a.actor_kind) === "dashed" &&
                        "rounded-full border border-dashed border-border-strong",
                    )}
                    aria-hidden
                  />
                  {t(activityLabel(a.type))}
                </div>
                {a.reason && <div className="mt-0.5 truncate text-muted-foreground">{t(a.reason)}</div>}
                <div className="text-muted-foreground">
                  {a.performed_by_name ?? t(actorLabel(a.actor_kind))} · {shortDate(a.performed_at, localeDaData)}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <SemLista vazio="Sem atividade." erro={erro} onTentarDeNovo={() => setTentativa((n) => n + 1)} />
        )}
      </section>

      <Separator />

      {/* Perguntar ao acervo — a MESMA busca que a IA faz, com a origem de cada
          trecho. Não é busca própria: o componente só pergunta e mostra, e quem
          decide limiar/top-K é a rota, que chama `buscarConhecimento`. Colocada
          DEPOIS das seções de trabalho: é consulta, não é o que o atendente abre
          a conversa para fazer. */}
      <section>
        <h3 className="text-xs font-semibold">{t("Acervo")}</h3>
        <p className="mt-1 mb-2 text-xs text-muted-foreground">
          {t("Pergunte como a IA perguntaria — a resposta vem com a origem de cada trecho.")}
        </p>
        <AcervoSearch />
      </section>
    </aside>
  );
}
