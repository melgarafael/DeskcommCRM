"use client";

import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";

import type { Locale } from "date-fns";
import Link from "next/link";
import { useT } from "@/hooks/i18n/useT";
import { useCallback, useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Tag, Receipt, Users, ArrowRight } from "@/lib/ui/icons";
import { apiClient } from "@/lib/api/client";
import { toast } from "sonner";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";
import { activityLabel, actorLabel, actorShape } from "@/lib/leads/activity-vocabulary";
import { ConversationTagsEditor } from "./ConversationTagsEditor";
import { ContactTagsEditor } from "./ContactTagsEditor";
import { useDefaultPipeline } from "@/hooks/pipelines/useDefaultPipeline";
import { NewLeadDialog } from "@/components/kanban/NewLeadDialog";
import { CustomFieldsEditor, type CustomFieldDef } from "@/components/contacts/CustomFieldsEditor";
import { useEditLead } from "@/hooks/kanban/useUpdateLead";
import { cn } from "@/lib/utils";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import { phoneForDisplay } from "@/lib/channels/phone-variants";

interface Props {
  conversation: ConversationWithContact | null;
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
  aberta_em: string;
  origem: string;
  estado: string;
  proximo_passo: string | null;
  proximo_passo_em: string | null;
  prazo_em: string | null;
}

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
function InboxLeadEditor({
  leads,
  selecionadoId,
  onSelecionar,
  onSalvo,
}: {
  leads: LeadRow[];
  selecionadoId: string | null;
  onSelecionar: (id: string) => void;
  onSalvo: () => void;
}) {
  const ativo = leads.find((l) => l.id === selecionadoId) ?? leads[0]!;

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
                  <div className="text-muted-foreground">
                    {l.status} · {formatMoney(l.value_cents, l.currency)}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {leads.length === 1 && (
        <p className="text-xs text-muted-foreground">
          {ativo.title} · {ativo.status}
        </p>
      )}
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

  if (fieldDefs.length === 0) {
    return <p className="text-xs text-muted-foreground">{t("Este funil não tem campos extras.")}</p>;
  }

  async function salvar() {
    try {
      await edit.mutateAsync({ leadId, patch: { custom_fields: customFields } });
      toast.success("Campos atualizados");
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

export function CRMSidePanel({ conversation }: Props) {
  const localeDaData = useLocaleDeData();
  const t = useT();
  const contact = conversation?.contacts ?? null;
  const contactId = contact?.id ?? null;

  const [leads, setLeads] = useState<LeadRow[] | null>(null);
  const [orders, setOrders] = useState<OrderRow[] | null>(null);
  const [activities, setActivities] = useState<ActivityRow[] | null>(null);
  const [demandas, setDemandas] = useState<DemandaRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  /**
   * O TERCEIRO ESTADO. Antes existiam dois — carregando e "tem N itens" — e a
   * falha era traduzida para lista vazia, virando "Sem leads.": uma afirmação
   * sobre o NEGÓCIO feita em cima de um erro de leitura. Distinguir "não tem"
   * de "não consegui ler" é a diferença entre informar e mentir.
   */
  const [erro, setErro] = useState(false);
  const [tentativa, setTentativa] = useState(0);

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
      setLeadAtivoId(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setErro(false);

    // Pela ROTA, não pelo cliente de navegador: o cookie de sessão é httpOnly,
    // então o supabase-js do browser não vê a sessão e consultava como `anon`
    // (medido: role=anon com gerente logado). Ver o cabeçalho da rota.
    async function load() {
      try {
        const r = await apiClient.get<{
          data: {
            leads: LeadRow[];
            orders: OrderRow[];
            activities: ActivityRow[];
            demandas: DemandaRow[];
          };
        }>(`/api/v1/contacts/${contactId}/crm-summary`);
        if (cancelled) return;
        setLeads(r.data.leads);
        setOrders(r.data.orders);
        setActivities(r.data.activities);
        // `?? []` e não `?? null`: aqui a leitura DEU CERTO. Cair em `null`
        // faria a lista vazia se disfarçar do terceiro estado e o painel
        // mostraria esqueleto para sempre num contato sem demanda aberta —
        // que é o caso saudável.
        setDemandas(r.data.demandas ?? []);
      } catch {
        if (cancelled) return;
        // Falha NÃO vira lista vazia. Os dados ficam `null` e o painel diz que
        // não conseguiu ler — nunca que não há.
        setErro(true);
        setLeads(null);
        setOrders(null);
        setActivities(null);
        setDemandas(null);
      } finally {
        if (!cancelled) setLoading(false);
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
  }, [contactId, tentativa, conversation?.assigned_to_user_id, conversation?.bot_silenced_until]);

  // Recarrega o resumo pelo MESMO caminho do "Tentar de novo": o efeito depende
  // de `tentativa`, então a demanda recém-marcada volta do servidor em vez de
  // ser apagada da lista no cliente. Sumir no otimismo esconderia uma escrita
  // que falhou depois — e escrita que parece ter dado certo é o defeito que
  // esta tela inteira combate.
  const recarregar = useCallback(() => setTentativa((n) => n + 1), []);

  const tags = contact?.tags ?? [];
  const displayName = rotuloDoContato(contact);

  // `erro` PRIMEIRO, e não é detalhe: as três listas voltam a `null` quando a
  // leitura falha, e este derivado lê `null` como "ainda não chegou". Sem esta
  // guarda o painel mostraria esqueleto para sempre e o estado de falha nunca
  // apareceria — o mesmo colapso de significados que criou o defeito original,
  // só que trocando "erro→vazio" por "erro→carregando".
  const sectionsLoading = useMemo(
    () =>
      !erro &&
      (loading || (leads === null && orders === null && activities === null && demandas === null)),
    [erro, loading, leads, orders, activities, demandas],
  );

  if (!conversation) {
    return (
      <aside className="flex h-full items-center justify-center border-l border-border p-4 text-center text-xs text-muted-foreground">
        {t("Selecione uma conversa para ver detalhes do contato.")}
      </aside>
    );
  }

  return (
    <aside className="flex h-full flex-col gap-4 overflow-y-auto border-l border-border bg-background p-4">
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
                <Badge key={t} variant="secondary" className="h-4 px-1.5 text-[10px]">
                  {t}
                </Badge>
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-2 pt-1">
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              disabled={!contactId}
              aria-pressed={tagEditorOpen}
              onClick={() => setTagEditorOpen((v) => !v)}
            >
              <Tag size={12} className="mr-1" weight="regular" aria-hidden /> {t("Tag")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              disabled={!contactId || (leadDialogOpen && defaultPipeline.isLoading)}
              onClick={() => setLeadDialogOpen(true)}
            >
              <Users size={12} className="mr-1" weight="regular" aria-hidden />
              {leadDialogOpen && defaultPipeline.isLoading ? t("Carregando…") : t("Lead")}
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
          {tagEditorOpen && contactId && <ContactTagsEditor contactId={contactId} tags={tags} />}
        </Card>
      </section>

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

      <ConversationTagsEditor
        conversationId={conversation.id}
        orgId={conversation.organization_id}
        tags={conversation.tags ?? []}
      />

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
                      {t("há")} {horasDesde(d.aberta_em)}h
                    </span>
                  </div>
                  {/* O invariante 4 na frase, não só na cor: quem enxerga mal
                      cor precisa ler a mesma informação. */}
                  <div className={cn("mt-0.5", semPasso ? "font-medium" : "text-muted-foreground")}>
                    {d.proximo_passo ?? t("Sem próximo passo definido")}
                  </div>
                  {/* A SAÍDA. Sem ela esta seção só denunciava: o atendente via o
                      vazamento e tinha de sair da tela para resolver — peça que
                      só recebe é ilha pelo invariante 1, e foi o gate dos mapas
                      de arquitetura que apontou isso. */}
                  {semPasso ? <MarcarProximoPasso demandaId={d.id} onPronto={recarregar} /> : null}
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

      <Separator />

      <section data-testid="inbox-campos-lead">
        <h3 className="text-xs font-semibold text-text">
          {t("Leads recentes")}
        </h3>
        {sectionsLoading ? (
          <Skeleton className="mt-2 h-14 w-full" />
        ) : leads && leads.length > 0 ? (
          <InboxLeadEditor
            leads={leads}
            selecionadoId={leadAtivoId}
            onSelecionar={setLeadAtivoId}
            onSalvo={recarregar}
          />
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
                {a.reason && <div className="mt-0.5 truncate text-muted-foreground">{a.reason}</div>}
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
    </aside>
  );
}
