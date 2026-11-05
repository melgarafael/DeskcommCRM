"use client";

/**
 * MENSAGENS AGENDADAS — botão ao lado do Enviar e popup com três visões:
 *  - as agendadas do contato (padrão);
 *  - "Exibir Todos": as agendadas de todos os contatos da organização;
 *  - "Relatório": os últimos envios do contato (enviados, falhados, pulados).
 */
import { useState } from "react";
import { CalendarClock, Eye, EyeOff, History, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";

const CHAVE_RAIZ = "mensagens-agendadas";

const RECORRENCIAS: { valor: string; rotulo: string }[] = [
  { valor: "nenhuma", rotulo: "Nenhuma (envio único)" },
  { valor: "diaria", rotulo: "Diária" },
  { valor: "semanal", rotulo: "Semanal" },
  { valor: "quinzenal", rotulo: "Quinzenal" },
  { valor: "mensal", rotulo: "Mensal" },
  { valor: "trimestral", rotulo: "Trimestral" },
  { valor: "semestral", rotulo: "Semestral" },
  { valor: "anual", rotulo: "Anual" },
  { valor: "a_cada_n_dias", rotulo: "A cada N dias" },
];

const DESFECHOS: Record<EnvioLinha["desfecho"], string> = {
  enviada: "Enviado",
  falhou: "Falhou",
  pulada_desconectado: "Pulado (desconectado)",
};

interface AgendamentoLinha {
  id: string;
  contact_id: string;
  channel_session_id: string;
  title: string | null;
  body: string;
  recorrencia: string;
  intervalo_dias: number | null;
  scheduled_at: string;
  se_desconectado: "esperar" | "cancelar";
  contacts?: { display_name: string | null; name: string | null } | null;
}

interface EnvioLinha {
  id: string;
  prevista_para: string;
  desfecho: "enviada" | "falhou" | "pulada_desconectado";
  erro: string | null;
  agendamento: {
    id: string;
    title: string | null;
    body: string;
    recorrencia: string;
    intervalo_dias: number | null;
    contact_id: string;
  } | null;
}

type Modo = "contato" | "todas" | "relatorio";

interface Props {
  contactId: string;
  channelSessionId: string;
  contactName?: string | null;
  /** Texto do campo de envio, para pré-preencher a nova mensagem. */
  textoInicial?: string;
}

function rotuloRecorrencia(a: { recorrencia: string; intervalo_dias: number | null }): string {
  if (a.recorrencia === "a_cada_n_dias") return `A cada ${a.intervalo_dias ?? "?"} dias`;
  return RECORRENCIAS.find((r) => r.valor === a.recorrencia)?.rotulo ?? a.recorrencia;
}

function formatarQuando(iso: string): string {
  return new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

function nomeDoContato(a: AgendamentoLinha): string {
  return a.contacts?.display_name || a.contacts?.name || "Sem nome";
}

/** Chave da lista de agendamentos de um contato: o badge e o popup dividem o mesmo cache. */
const chaveDaLista = (contactId: string) => [CHAVE_RAIZ, contactId] as const;
const CHAVE_TODAS = [CHAVE_RAIZ, "todas"] as const;
const chaveDosEnvios = (contactId: string) => [CHAVE_RAIZ, "envios", contactId] as const;

function buscarAgendamentos(contactId: string) {
  return apiClient.get<{ data: AgendamentoLinha[] }>(
    `/api/v1/mensagens-agendadas?contact_id=${encodeURIComponent(contactId)}`,
  );
}

function buscarTodas() {
  return apiClient.get<{ data: AgendamentoLinha[] }>("/api/v1/mensagens-agendadas");
}

function buscarEnvios(contactId: string) {
  return apiClient.get<{ data: EnvioLinha[] }>(
    `/api/v1/mensagens-agendadas/envios?contact_id=${encodeURIComponent(contactId)}`,
  );
}

/**
 * Consulta compartilhada pelo badge e pelo popup. Se a primeira busca falhar
 * (timeout com o servidor ocupado, rede oscilando), o badge fica em branco até
 * alguém recarregar: por isso tenta de novo e busca de novo ao voltar à aba.
 */
function opcoesDaLista(contactId: string) {
  return {
    queryKey: chaveDaLista(contactId),
    queryFn: () => buscarAgendamentos(contactId),
    staleTime: 0,
    retry: 3,
    refetchOnWindowFocus: true,
  };
}

/** Botão ao lado do Enviar, com o número de mensagens agendadas do contato. */
export function MensagensAgendadasBotao(props: Props) {
  const [aberto, setAberto] = useState(false);
  const { contactId } = props;

  // Mesma consulta do popup: sempre que o botão monta, busca de novo, e o popup
  // invalida esta chave ao criar ou cancelar, então o número nunca fica para trás.
  const consulta = useQuery(opcoesDaLista(contactId));
  const total = consulta.data?.data.length ?? 0;

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="relative shrink-0"
        onClick={() => setAberto(true)}
        aria-label="Mensagens agendadas"
        title="Mensagens agendadas"
        data-testid="botao-mensagens-agendadas"
      >
        <CalendarClock className="size-5" aria-hidden />
        {total ? (
          <span className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-primary px-1 text-[10px] leading-4 text-primary-foreground">
            {total}
          </span>
        ) : null}
      </Button>
      {aberto && <MensagensAgendadasDialog {...props} open onOpenChange={setAberto} />}
    </>
  );
}

export function MensagensAgendadasDialog({
  open,
  onOpenChange,
  contactId,
  channelSessionId,
  contactName,
  textoInicial,
}: Props & { open: boolean; onOpenChange: (v: boolean) => void }) {
  const t = useT();
  const [modo, setModo] = useState<Modo>("contato");
  const [criando, setCriando] = useState(false);
  const qc = useQueryClient();

  const consulta = useQuery(opcoesDaLista(contactId));
  const todas = useQuery({
    queryKey: CHAVE_TODAS,
    queryFn: buscarTodas,
    enabled: modo === "todas",
    staleTime: 0,
    retry: 3,
    refetchOnWindowFocus: true,
  });
  const envios = useQuery({
    queryKey: chaveDosEnvios(contactId),
    queryFn: () => buscarEnvios(contactId),
    staleTime: 0,
    retry: 3,
    refetchOnWindowFocus: true,
  });

  const consultaAtiva = modo === "todas" ? todas : consulta;
  const lista = consultaAtiva.data?.data ?? [];
  const totalEnvios = envios.data?.data.length ?? 0;

  // Criar, editar ou cancelar mexe nas três visões: invalida o prefixo inteiro.
  const atualizarTudo = () => qc.invalidateQueries({ queryKey: [CHAVE_RAIZ] });

  function alternar(alvo: Exclude<Modo, "contato">) {
    setCriando(false);
    setModo((atual) => (atual === alvo ? "contato" : alvo));
  }

  async function cancelar(id: string) {
    try {
      await apiClient.delete(`/api/v1/mensagens-agendadas/${id}`);
      toast.success("Agendamento cancelado.");
      await atualizarTudo();
    } catch {
      toast.error("Não consegui cancelar o agendamento.");
    }
  }

  const titulo =
    modo === "relatorio"
      ? "Relatório"
      : modo === "todas"
        ? "Todas as mensagens agendadas"
        : `Mensagens agendadas${contactName ? ` — ${contactName}` : ""}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{titulo}</DialogTitle>
        </DialogHeader>

        {!criando && (
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant={modo === "relatorio" ? "secondary" : "outline"}
              size="sm"
              aria-pressed={modo === "relatorio"}
              onClick={() => alternar("relatorio")}
            >
              <History className="mr-1 size-4" aria-hidden />
              {modo === "relatorio" ? "Ocultar" : "Relatório"}
              {modo !== "relatorio" && totalEnvios > 0 ? (
                <span className="ml-1 rounded-full bg-primary px-1.5 text-[10px] leading-4 text-primary-foreground">
                  {totalEnvios}
                </span>
              ) : null}
            </Button>
            <Button
              type="button"
              variant={modo === "todas" ? "secondary" : "outline"}
              size="sm"
              aria-pressed={modo === "todas"}
              onClick={() => alternar("todas")}
            >
              {modo === "todas" ? (
                <>
                  <EyeOff className="mr-1 size-4" aria-hidden /> Ocultar
                </>
              ) : (
                <>
                  <Eye className="mr-1 size-4" aria-hidden /> Exibir Todos
                </>
              )}
            </Button>
          </div>
        )}

        {criando ? (
          <CriarAgendamento
            contactId={contactId}
            channelSessionId={channelSessionId}
            textoInicial={textoInicial ?? ""}
            onCancelar={() => setCriando(false)}
            onCriado={async () => {
              setCriando(false);
              await atualizarTudo();
            }}
          />
        ) : modo === "relatorio" ? (
          <div className="space-y-3">
            {envios.isPending ? (
              <p className="text-sm text-muted-foreground">Carregando…</p>
            ) : totalEnvios === 0 ? (
              <p className="text-sm text-muted-foreground">Nenhum envio realizado para este contato ainda.</p>
            ) : (
              <ul className="divide-y rounded-md border">
                {envios.data?.data.map((e) => (
                  <li key={e.id} className="flex items-center gap-3 p-3 text-sm">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{e.agendamento?.title || e.agendamento?.body || "Mensagem"}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatarQuando(e.prevista_para)}
                        {e.agendamento ? ` · ${rotuloRecorrencia(e.agendamento)}` : ""}
                        {e.erro ? ` · ${e.erro}` : ""}
                      </p>
                    </div>
                    <span
                      className={
                        e.desfecho === "enviada"
                          ? "rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800"
                          : e.desfecho === "falhou"
                            ? "rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-800"
                            : "rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                      }
                    >
                      {DESFECHOS[e.desfecho]}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {consultaAtiva.isPending ? (
              <p className="text-sm text-muted-foreground">Carregando…</p>
            ) : lista.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("Nenhuma mensagem agendada para este contato.")}</p>
            ) : (
              <ul className="divide-y rounded-md border">
                {lista.map((a) => (
                  <li key={a.id} className="flex items-center gap-3 p-3 text-sm">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{a.title || a.body}</p>
                      <p className="text-xs text-muted-foreground">
                        {modo === "todas" ? `${nomeDoContato(a)} · ` : ""}
                        {formatarQuando(a.scheduled_at)} · {rotuloRecorrencia(a)}
                        {a.se_desconectado === "cancelar" ? " · cancela se desconectado" : ""}
                      </p>
                    </div>
                    <Button type="button" size="icon" variant="ghost" aria-label="Cancelar agendamento" onClick={() => void cancelar(a.id)}>
                      <Trash2 className="size-4" aria-hidden />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex justify-end">
              <Button type="button" onClick={() => setCriando(true)}>
                <Plus className="mr-1 size-4" aria-hidden /> Adicionar
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function CriarAgendamento({
  textoInicial,
  contactId,
  channelSessionId,
  onCancelar,
  onCriado,
}: {
  textoInicial: string;
  contactId: string;
  channelSessionId: string;
  onCancelar: () => void;
  onCriado: () => Promise<void>;
}) {
  const t = useT();
  const [titulo, setTitulo] = useState("");
  const [texto, setTexto] = useState(textoInicial);
  const [data, setData] = useState("");
  const [hora, setHora] = useState("");
  const [recorrencia, setRecorrencia] = useState("nenhuma");
  const [intervaloDias, setIntervaloDias] = useState("");
  const [temTermino, setTemTermino] = useState(false);
  const [termino, setTermino] = useState("");
  const [seDesconectado, setSeDesconectado] = useState<"esperar" | "cancelar">("esperar");
  const [salvando, setSalvando] = useState(false);

  async function salvar() {
    if (!texto.trim()) return toast.error("Escreva a mensagem.");
    if (!data || !hora) return toast.error("Escolha a data e a hora.");
    if (recorrencia === "a_cada_n_dias" && !intervaloDias) return toast.error("Informe de quantos em quantos dias.");

    setSalvando(true);
    try {
      await apiClient.post("/api/v1/mensagens-agendadas", {
        contact_id: contactId,
        channel_session_id: channelSessionId,
        title: titulo.trim() || null,
        body: texto,
        recorrencia,
        intervalo_dias: recorrencia === "a_cada_n_dias" ? Number(intervaloDias) : null,
        inicio_local: `${data}T${hora}`,
        termino_local: temTermino && termino ? `${termino}T23:59` : null,
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        se_desconectado: seDesconectado,
      });
      toast.success("Agendamento criado.");
      await onCriado();
    } catch {
      toast.error("Não consegui criar o agendamento. Confira os campos.");
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Label htmlFor="ag-titulo">{t("Título (opcional)")}</Label>
        <Input id="ag-titulo" value={titulo} onChange={(e) => setTitulo(e.target.value)} placeholder={t("Insira aqui o título")} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="ag-texto">Mensagem</Label>
        <Textarea id="ag-texto" value={texto} onChange={(e) => setTexto(e.target.value)} placeholder={t("Insira sua mensagem")} rows={4} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor="ag-data">Data</Label>
          <Input id="ag-data" type="date" value={data} onChange={(e) => setData(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="ag-hora">Hora</Label>
          <Input id="ag-hora" type="time" value={hora} onChange={(e) => setHora(e.target.value)} />
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="ag-recorrencia">{t("Recorrência")}</Label>
        <select
          id="ag-recorrencia"
          className="h-9 w-full rounded-md border bg-background px-2 text-sm"
          value={recorrencia}
          onChange={(e) => setRecorrencia(e.target.value)}
        >
          {RECORRENCIAS.map((r) => (
            <option key={r.valor} value={r.valor}>
              {r.rotulo}
            </option>
          ))}
        </select>
      </div>
      {recorrencia === "a_cada_n_dias" && (
        <Input
          type="number"
          min={1}
          max={365}
          value={intervaloDias}
          onChange={(e) => setIntervaloDias(e.target.value)}
          placeholder="Insira de quantos em quantos dias"
        />
      )}
      {recorrencia !== "nenhuma" && (
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={temTermino} onChange={(e) => setTemTermino(e.target.checked)} />
            {t("Definir data de término")}
          </label>
          {temTermino && <Input type="date" value={termino} onChange={(e) => setTermino(e.target.value)} />}
        </div>
      )}
      <div className="space-y-1">
        <Label htmlFor="ag-desconectado">Se o WhatsApp estiver desconectado na hora</Label>
        <select
          id="ag-desconectado"
          className="h-9 w-full rounded-md border bg-background px-2 text-sm"
          value={seDesconectado}
          onChange={(e) => setSeDesconectado(e.target.value as "esperar" | "cancelar")}
        >
          <option value="esperar">Esperar reconectar e enviar</option>
          <option value="cancelar">{t("Cancelar este envio")}</option>
        </select>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancelar}>
          <X className="mr-1 size-4" aria-hidden /> Cancelar
        </Button>
        <Button type="button" onClick={() => void salvar()} disabled={salvando}>
          {salvando ? "Criando…" : "Criar"}
        </Button>
      </div>
    </div>
  );
}
