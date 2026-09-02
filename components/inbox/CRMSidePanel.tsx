"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import { pt as ptBR } from "date-fns/locale";
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
import { cn } from "@/lib/utils";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";

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
      toast.error("Não consegui salvar o próximo passo. Tente de novo.");
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
        Marcar próximo passo
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
        placeholder="O que acontece a seguir?"
        aria-label="Próximo passo desta demanda"
        data-testid="campo-proximo-passo"
        className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
      />
      <div className="flex gap-1.5">
        <Button
          size="sm"
          className="h-7 text-xs"
          disabled={salvando || texto.trim().length < 3}
          data-testid="salvar-proximo-passo"
          onClick={() => void salvar()}
        >
          {salvando ? "Salvando…" : "Salvar"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs"
          onClick={() => setAberto(false)}
        >
          Cancelar
        </Button>
      </div>
    </div>
  );
}

function formatMoney(cents: number | null, currency: string | null): string {
  if (cents == null) return "—";
  const cur = currency ?? "MZN";
  try {
    return new Intl.NumberFormat("pt-MZ", { style: "currency", currency: cur }).format(
      cents / 100,
    );
  } catch {
    return `${(cents / 100).toFixed(2)} ${cur}`;
  }
}

function shortDate(iso: string): string {
  return format(new Date(iso), "dd/MM/yy HH:mm", { locale: ptBR });
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
  if (!erro) return <p className="mt-2 text-xs text-muted-foreground">{vazio}</p>;
  return (
    <div className="mt-2 space-y-1">
      <p className="text-xs text-error-fg">Não consegui ler estes dados.</p>
      <Button size="sm" variant="outline" onClick={onTentarDeNovo}>
        Tentar de novo
      </Button>
    </div>
  );
}

export function CRMSidePanel({ conversation }: Props) {
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
  const defaultPipeline = useDefaultPipeline(leadDialogOpen);

  useEffect(() => {
    if (leadDialogOpen && defaultPipeline.isError) {
      toast.error("Nenhum funil configurado nesta organização.");
      setLeadDialogOpen(false);
    }
  }, [leadDialogOpen, defaultPipeline.isError]);

  useEffect(() => {
    if (!contactId) {
      setLeads(null);
      setOrders(null);
      setActivities(null);
      setDemandas(null);
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
  }, [contactId, tentativa]);

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
        Selecione uma conversa para ver detalhes do contato.
      </aside>
    );
  }

  return (
    <aside className="flex h-full flex-col gap-4 overflow-y-auto border-l border-border bg-background p-4">
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Contato
        </h3>
        <Card className="mt-2 space-y-2 p-3 text-sm">
          <div className="font-medium">{displayName}</div>
          {contact?.phone_number && (
            <div className="text-xs text-muted-foreground">{contact.phone_number}</div>
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
              <Tag size={12} className="mr-1" weight="regular" aria-hidden /> Tag
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              disabled={!contactId || (leadDialogOpen && defaultPipeline.isLoading)}
              onClick={() => setLeadDialogOpen(true)}
            >
              <Users size={12} className="mr-1" weight="regular" aria-hidden />
              {leadDialogOpen && defaultPipeline.isLoading ? "Carregando…" : "Lead"}
            </Button>
            {contactId && (
              <Button asChild size="sm" variant="ghost" className="h-7 px-2 text-xs">
                <Link href={`/app/contacts/${contactId}`}>
                  Ver contato
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
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Demandas abertas
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
                      {ESTADO_LEGIVEL[d.estado] ?? d.estado}
                    </span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      há {horasDesde(d.aberta_em)}h
                    </span>
                  </div>
                  {/* O invariante 4 na frase, não só na cor: quem enxerga mal
                      cor precisa ler a mesma informação. */}
                  <div className={cn("mt-0.5", semPasso ? "font-medium" : "text-muted-foreground")}>
                    {d.proximo_passo ?? "Sem próximo passo definido"}
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

      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Leads recentes
        </h3>
        {sectionsLoading ? (
          <Skeleton className="mt-2 h-14 w-full" />
        ) : leads && leads.length > 0 ? (
          <ul className="mt-2 space-y-1.5">
            {leads.map((l) => (
              <li
                key={l.id}
                className="flex items-center justify-between rounded-md border border-border p-2 text-xs"
              >
                <div className="min-w-0">
                  <div className="truncate font-medium">{l.title}</div>
                  <div className="text-muted-foreground">
                    {l.status} · {formatMoney(l.value_cents, l.currency)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <SemLista vazio="Sem leads." erro={erro} onTentarDeNovo={() => setTentativa((n) => n + 1)} />
        )}
      </section>

      <Separator />

      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Pedidos recentes
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
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Atividade
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
                  {activityLabel(a.type)}
                </div>
                {a.reason && <div className="mt-0.5 truncate text-muted-foreground">{a.reason}</div>}
                <div className="text-muted-foreground">
                  {actorLabel(a.actor_kind)} · {shortDate(a.performed_at)}
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
