"use client";
/**
 * A campanha por dentro (PRD §25): resumo, mensagem, público, destinatários e as
 * ações que cabem NO ESTADO ATUAL.
 *
 * ═══ Por que os botões somem em vez de desabilitar ═══
 *
 * "Iniciar" numa campanha concluída não é uma ação bloqueada, é uma ação que não
 * existe. Botão cinza convida a clicar e depois explica; a máquina de estados já
 * sabe o que cabe, e a tela mostra só isso (PRD §34: evitar ações impossíveis).
 *
 * ═══ Por que o número de "quem ficou de fora" tem destaque ═══
 *
 * É a pergunta que o operador faz primeiro quando 500 viram 80. Sem o motivo ao
 * lado do número, ele conclui que o sistema comeu a lista.
 */
import Link from "next/link";
import { useState } from "react";

import { EstadoDaCampanha } from "@/components/campanhas/EstadoDaCampanha";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useAcaoDeCampanha,
  useCampanha,
  useDestinatarios,
  useEditarCampanha,
  useMetricasDaCampanha,
  type AcaoDeCampanha,
  type CampanhaDetalhada,
} from "@/hooks/campanhas/useCampanhas";
import { useAgentesPublicados, useFunis } from "@/hooks/campanhas/useDestinoDaCampanha";
import { channelLabel, useChannelSessions } from "@/hooks/channels/useChannelSessions";
import { useContactList } from "@/hooks/contacts/useContactList";
import { useT } from "@/hooks/i18n/useT";
import { ArrowBendUpLeft } from "@/lib/ui/icons";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import { TEXTO_DA_EXCLUSAO } from "@/lib/campanhas/tipos";

export function DetalheDaCampanha({ id }: { id: string }) {
  const t = useT();
  const campanha = useCampanha(id);
  const metricas = useMetricasDaCampanha(id, campanha.data?.status);
  const [filtroDeStatus, setFiltroDeStatus] = useState("");
  const destinatarios = useDestinatarios(id, { status: filtroDeStatus || undefined });
  const acao = useAcaoDeCampanha(id);
  const [confirmando, setConfirmando] = useState<AcaoDeCampanha | null>(null);
  const [testando, setTestando] = useState(false);

  if (campanha.isLoading) {
    return (
      <div className="space-y-3 p-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }
  if (campanha.isError || !campanha.data) {
    return (
      <div className="p-6">
        <Card className="p-6 text-center">
          <p className="text-sm text-error-fg">{t("Não foi possível carregar a campanha.")}</p>
          <Button size="sm" variant="outline" className="mt-2" onClick={() => campanha.refetch()}>
            {t("Tentar novamente")}
          </Button>
        </Card>
      </div>
    );
  }

  const c = campanha.data;
  const m = metricas.data;
  const linhas = destinatarios.data?.pages.flatMap((p) => p.data) ?? [];

  // As ações que cabem NO ESTADO — a mesma tabela da máquina de estados do
  // servidor, que é quem recusa de verdade. Aqui é só para não oferecer o
  // impossível.
  const disponiveis: AcaoDeCampanha[] = [];
  // Cancelar também de rascunho e de preparada: desistir é decisão legítima
  // antes do fim, e é mais segura quanto mais cedo. Ver a tabela em
  // `lib/campanhas/maquina-de-estados.ts`, que diverge da Spec 12 §7.3 aqui.
  if (c.status === "draft") disponiveis.push("preparar", "cancelar");
  if (c.status === "ready") disponiveis.push("testar", "iniciar", "cancelar");
  if (c.status === "running") disponiveis.push("pausar", "cancelar");
  if (c.status === "scheduled") disponiveis.push("pausar", "cancelar");
  if (c.status === "paused") disponiveis.push("retomar", "cancelar");
  disponiveis.push("duplicar");

  return (
    <div className="space-y-4 p-6">
      <div>
        <Link
          href="/app/campaigns"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-text"
        >
          <ArrowBendUpLeft size={14} aria-hidden />
          {t("Campanhas")}
        </Link>
      </div>

      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{c.name}</h1>
            <EstadoDaCampanha status={c.status} />
          </div>
          {c.failure_code && (
            <p className="mt-1 text-sm text-warning-fg">
              {t("Último problema")}: {c.failure_code}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {c.status === "draft" && (
            <Button variant="outline" asChild>
              <Link href={`/app/campaigns/${c.id}/edit`}>{t("Editar")}</Link>
            </Button>
          )}
          {disponiveis.map((a) => (
            <Button
              key={a}
              variant={a === "cancelar" ? "outline" : "default"}
              disabled={acao.isPending}
              onClick={() => {
                // Iniciar e cancelar mexem com gente de verdade: confirmação
                // explícita (PRD §34). As outras não pedem cerimônia.
                if (a === "iniciar" || a === "cancelar") setConfirmando(a);
                // O teste precisa saber PARA QUEM: mandar para o primeiro da
                // lista transformaria um teste num envio real a um prospect.
                else if (a === "testar") setTestando(true);
                else acao.mutate({ acao: a });
              }}
            >
              {t(ROTULO_DA_ACAO[a])}
            </Button>
          ))}
        </div>
      </header>

      {confirmando && (
        <Card className="space-y-3 border-warning-fg p-4">
          <p className="text-sm">
            {confirmando === "iniciar"
              ? `${t("Começar a enviar para")} ${c.snapshot_eligible} ${c.snapshot_eligible === 1 ? t("pessoa?") : t("pessoas?")} ${t("O envio segue o ritmo do número e pode levar horas.")}`
              : t("Cancelar é definitivo: quem ainda não recebeu não recebe mais, e a campanha não volta a rodar.")}
          </p>
          <div className="flex gap-2">
            <Button
              disabled={acao.isPending}
              onClick={() => {
                acao.mutate({ acao: confirmando });
                setConfirmando(null);
              }}
            >
              {t("Confirmar")}
            </Button>
            <Button variant="outline" onClick={() => setConfirmando(null)}>
              {t("Voltar")}
            </Button>
          </div>
        </Card>
      )}

      {testando && (
        <TesteDaCampanha
          onCancelar={() => setTestando(false)}
          onEnviar={(contactId) => {
            acao.mutate({ acao: "testar", corpo: { contact_id: contactId } });
            setTestando(false);
          }}
          enviando={acao.isPending}
        />
      )}

      <div className="grid gap-4 sm:grid-cols-4">
        <Numero titulo={t("Na lista")} valor={c.snapshot_eligible} />
        <Numero titulo={t("Enviadas")} valor={m?.contagem.enviados ?? 0} />
        <Numero titulo={t("Entregues")} valor={m?.contagem.entregues ?? 0} />
        <Numero titulo={t("Responderam")} valor={m?.contagem.responderam ?? 0} />
      </div>

      {m && (
        <Card className="space-y-2 p-4">
          <div className="flex items-baseline justify-between">
            <h2 className="font-medium">{t("Progresso")}</h2>
            <span className="text-sm text-muted-foreground">
              {Math.round(m.progresso * 100)}%
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-surface-elevated">
            <div
              className="h-full bg-accent-500"
              style={{ width: `${Math.round(m.progresso * 100)}%` }}
              role="progressbar"
              aria-valuenow={Math.round(m.progresso * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={t("Progresso do envio")}
            />
          </div>
          <p className="text-sm text-muted-foreground">
            {m.contagem.pendentes} {t("ainda não enviadas")} · {m.contagem.falharam} {t("falharam")} ·{" "}
            {m.contagem.optOut} {t("pediram para parar")}
          </p>
        </Card>
      )}

      <DestinoDaCampanha campanha={c} />

      <NumerosDaCampanha campanha={c} />

      <RitmoDaCampanha campanha={c} />

      <Card className="space-y-2 p-4">
        <h2 className="font-medium">{t("Mensagem")}</h2>
        <p className="whitespace-pre-wrap text-sm">{c.message_body}</p>
        <p className="text-xs text-muted-foreground">
          {t("Base legal")}: {c.base_legal === "consent" ? t("consentimento") : t("interesse legítimo")}
          {c.lia_ref ? ` (${c.lia_ref})` : ""}
        </p>
      </Card>

      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-medium">{t("Quem está na lista")}</h2>
          <select
            className="h-9 rounded-md border border-border bg-surface px-2 text-sm"
            value={filtroDeStatus}
            onChange={(e) => setFiltroDeStatus(e.target.value)}
            aria-label={t("Filtrar destinatários")}
          >
            <option value="">{t("Todos")}</option>
            <option value="pending">{t("Ainda não enviadas")}</option>
            <option value="sent">{t("Enviadas")}</option>
            <option value="delivered">{t("Entregues")}</option>
            <option value="read">{t("Lidas")}</option>
            <option value="replied">{t("Responderam")}</option>
            <option value="skipped">{t("Fora da lista")}</option>
            <option value="failed">{t("Falharam")}</option>
          </select>
        </div>

        {c.snapshot_total === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("A lista ainda não foi montada. Use Preparar para ver quem entra.")}
          </p>
        ) : (
          <div className="divide-y divide-border">
            {linhas.map((d) => (
              <div key={d.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className="min-w-0 truncate">
                  {rotuloDoContato(d.contacts, t)}
                </span>
                <span className="shrink-0 text-muted-foreground">
                  {d.eligibility_status === "excluded"
                    ? t(d.legenda_da_exclusao ?? rotuloDoMotivo(d.exclusion_reason))
                    : t(ROTULO_DO_DESTINATARIO[d.status] ?? d.status)}
                </span>
              </div>
            ))}
            {destinatarios.hasNextPage && (
              <div className="pt-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => destinatarios.fetchNextPage()}
                  disabled={destinatarios.isFetchingNextPage}
                >
                  {t("Carregar mais")}
                </Button>
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}

/**
 * Para quem vai o teste.
 *
 * Um campo de busca sobre os contatos que a organização já tem, e não um campo
 * de telefone livre: o envio de teste passa pela MESMA cadeia do envio real
 * (mesma conexão, mesmo renderizador, mesmos vetos), e essa cadeia fala com
 * contato do CRM. Número digitado à mão criaria cadastro fantasma a cada teste.
 */
function TesteDaCampanha({
  onCancelar,
  onEnviar,
  enviando,
}: {
  onCancelar: () => void;
  onEnviar: (contactId: string) => void;
  enviando: boolean;
}) {
  const t = useT();
  const [busca, setBusca] = useState("");
  const contatos = useContactList({ search: busca || undefined, limit: 10 });
  const encontrados = contatos.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <Card className="space-y-3 p-4">
      <h2 className="font-medium">{t("Enviar teste")}</h2>
      <p className="text-sm text-muted-foreground">
        {t(
          "Sai pelo mesmo número e com o mesmo texto do envio real — inclusive o horário da saudação. Não entra nos números da campanha.",
        )}
      </p>
      <Input
        value={busca}
        onChange={(e) => setBusca(e.target.value)}
        placeholder={t("Busque o contato pelo nome ou telefone")}
        aria-label={t("Contato do teste")}
      />
      <div className="divide-y divide-border">
        {encontrados.slice(0, 8).map((c) => (
          <div key={c.id} className="flex items-center justify-between gap-2 py-2 text-sm">
            <span className="min-w-0 truncate">{rotuloDoContato(c, t)}</span>
            <Button size="sm" variant="outline" disabled={enviando} onClick={() => onEnviar(c.id)}>
              {t("Enviar para este")}
            </Button>
          </div>
        ))}
        {encontrados.length === 0 && (
          <p className="py-2 text-sm text-muted-foreground">{t("Nenhum contato encontrado.")}</p>
        )}
      </div>
      <Button variant="outline" size="sm" onClick={onCancelar}>
        {t("Fechar")}
      </Button>
    </Card>
  );
}

/**
 * O que acontece com quem responde: em qual funil o card nasce e quem atende.
 *
 * Só aparece quando a campanha DECLAROU algo. Em branco, o comportamento é o de
 * sempre (funil e agente do número) e um card dizendo "padrão" seria ruído numa
 * tela que já tem muita informação.
 */
function DestinoDaCampanha({ campanha }: { campanha: CampanhaDetalhada }) {
  const t = useT();
  const funis = useFunis();
  const agentes = useAgentesPublicados();
  if (!campanha.pipeline_id && !campanha.agent_id) return null;

  const funil = (funis.data ?? []).find((f) => f.id === campanha.pipeline_id);
  const agente = (agentes.data ?? []).find((a) => a.id === campanha.agent_id);

  return (
    <Card className="space-y-2 p-4">
      <h2 className="font-medium">{t("Quem responder")}</h2>
      {campanha.pipeline_id && (
        <p className="text-sm">
          {t("Vira card no funil")}: <strong>{funil?.name ?? t("funil removido")}</strong>
        </p>
      )}
      {campanha.agent_id && (
        <p className="text-sm">
          {t("Quem atende a resposta")}: <strong>{agente?.name ?? t("agente indisponível")}</strong>
        </p>
      )}
    </Card>
  );
}

/**
 * Por quais números a campanha fala.
 *
 * Existe porque "quem falou com esta pessoa?" é a primeira pergunta quando o
 * cliente responde citando um número — e porque o operador precisa ver que o
 * rodízio está ligado antes de estranhar que as mensagens saiam de remetentes
 * diferentes.
 */
function NumerosDaCampanha({ campanha }: { campanha: CampanhaDetalhada }) {
  const t = useT();
  const canais = useChannelSessions();
  const extras = campanha.channel_session_ids ?? [];
  if (extras.length === 0) return null;

  const nome = (id: string) => {
    const c = (canais.data ?? []).find((x) => x.id === id);
    return c ? channelLabel(c, t) : id.slice(0, 8);
  };

  return (
    <Card className="space-y-2 p-4">
      <h2 className="font-medium">{t("Números desta campanha")}</h2>
      <p className="text-sm text-muted-foreground">
        {t("A cada envio, a campanha usa o número com mais folga no teto do dia — e o número que a pessoa já conhece, quando ela já conversou com algum deles.")}
      </p>
      <ul className="text-sm">
        {[campanha.channel_session_id, ...extras].map((id) => (
          <li key={id}>• {nome(id)}</li>
        ))}
      </ul>
    </Card>
  );
}

/**
 * O ritmo, editável com a campanha EM PÉ.
 *
 * A API aceita mexer no ritmo em qualquer estado vivo (só conteúdo e público
 * ficam presos ao rascunho), e a tela precisa oferecer isso: quem vê a campanha
 * andando rápido demais tem de poder desacelerá-la agora, não duplicá-la. Em
 * branco herda o número — que é onde mora a proteção de envio da conexão.
 */
function RitmoDaCampanha({ campanha }: { campanha: CampanhaDetalhada }) {
  const t = useT();
  const editar = useEditarCampanha(campanha.id);
  const [intervalo, setIntervalo] = useState(texto(campanha.intervalo_segundos));
  const [tetoDia, setTetoDia] = useState(texto(campanha.teto_diario));
  const [tetoHora, setTetoHora] = useState(texto(campanha.teto_horario));
  const [inicio, setInicio] = useState(texto(campanha.janela_inicio_hora));
  const [fim, setFim] = useState(texto(campanha.janela_fim_hora));

  const encerrada = campanha.status === "completed" || campanha.status === "cancelled";
  if (encerrada) return null;

  return (
    <Card className="space-y-4 p-4">
      <div>
        <h2 className="font-medium">{t("Ritmo desta campanha")}</h2>
        <p className="text-sm text-muted-foreground">
          {t(
            "Em branco, vale o ritmo do número (Conexões › Proteção de envio). O que você puser aqui só pode deixar mais devagar.",
          )}
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <CampoDeRitmo id="r-intervalo" rotulo={t("Intervalo mínimo entre mensagens (segundos)")} valor={intervalo} onChange={setIntervalo} />
        <CampoDeRitmo id="r-dia" rotulo={t("Máximo por dia")} valor={tetoDia} onChange={setTetoDia} />
        <CampoDeRitmo id="r-hora" rotulo={t("Máximo por hora")} valor={tetoHora} onChange={setTetoHora} />
        <div />
        <CampoDeRitmo id="r-inicio" rotulo={t("Enviar só a partir das (hora)")} valor={inicio} onChange={setInicio} />
        <CampoDeRitmo id="r-fim" rotulo={t("Parar de enviar às (hora)")} valor={fim} onChange={setFim} />
      </div>
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          disabled={editar.isPending}
          onClick={() =>
            editar.mutate({
              intervalo_segundos: numero(intervalo),
              teto_diario: numero(tetoDia),
              teto_horario: numero(tetoHora),
              janela_inicio_hora: numero(inicio),
              janela_fim_hora: numero(fim),
            })
          }
        >
          {editar.isPending ? t("Salvando…") : t("Salvar ritmo")}
        </Button>
        {editar.isSuccess && !editar.isPending && (
          <span className="text-sm text-success-fg">{t("Ritmo salvo.")}</span>
        )}
      </div>
    </Card>
  );
}

function CampoDeRitmo({
  id,
  rotulo,
  valor,
  onChange,
}: {
  id: string;
  rotulo: string;
  valor: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{rotulo}</Label>
      <Input id={id} type="number" min={0} value={valor} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

/** `null` vira campo vazio — e campo vazio volta a ser `null`, que é "herda o número". */
function texto(valor: number | null): string {
  return valor === null || valor === undefined ? "" : String(valor);
}

function numero(valor: string): number | null {
  const limpo = valor.trim();
  if (limpo === "") return null;
  const n = Number(limpo);
  return Number.isFinite(n) ? n : null;
}

function Numero({ titulo, valor }: { titulo: string; valor: number }) {
  return (
    <Card className="p-4">
      <p className="text-sm text-muted-foreground">{titulo}</p>
      <p className="text-2xl font-semibold">{valor}</p>
    </Card>
  );
}

const ROTULO_DA_ACAO: Record<AcaoDeCampanha, string> = {
  preparar: "Preparar lista",
  iniciar: "Iniciar envio",
  agendar: "Agendar",
  pausar: "Pausar",
  retomar: "Retomar",
  cancelar: "Cancelar campanha",
  duplicar: "Duplicar",
  testar: "Enviar teste",
};

const ROTULO_DO_DESTINATARIO: Record<string, string> = {
  pending: "Na fila",
  queued: "Na fila",
  sending: "Enviando",
  sent: "Enviada",
  delivered: "Entregue",
  read: "Lida",
  replied: "Respondeu",
  failed: "Falhou",
  skipped: "Fora da lista",
  cancelled: "Cancelada",
  opted_out: "Pediu para parar",
};

function rotuloDoMotivo(motivo: string | null): string {
  if (!motivo) return "Fora da lista";
  return (TEXTO_DA_EXCLUSAO as Record<string, string>)[motivo] ?? motivo;
}
