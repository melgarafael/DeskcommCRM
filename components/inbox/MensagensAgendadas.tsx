"use client";

/**
 * MENSAGENS AGENDADAS — botão ao lado do Enviar e popup da CONVERSA:
 *  - as agendadas pendentes (padrão), com editar e cancelar;
 *  - "Relatório": as que já tiveram desfecho, com o status real da mensagem.
 *
 * Primeira parte da #3118 (contribuição de @DIOGRO83): envio único, só nas
 * conversas que o atendente já enxerga. Repetição e a visão de todos os
 * clientes ficam para a segunda parte.
 */
import { useState } from "react";
import { CalendarClock, History, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { apiClient } from "@/lib/api/client";
import { PencilSimple, Trash } from "@/lib/ui/icons";
import { useT } from "@/hooks/i18n/useT";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { desfechoDoAgendamento, type Desfecho } from "@/lib/agendamento-mensagem/desfecho";

interface Agendamento {
  id: string;
  title: string | null;
  body: string;
  scheduled_at: string;
  status: "agendada" | "encaminhada" | "falhou" | "cancelada";
  se_desconectado: "esperar" | "cancelar";
  motivo: string | null;
  mensagem: { status: string } | null;
}

/** Texto de cada desfecho e de cada motivo — `t()` com literal, nunca chave montada em runtime. */
function rotuloDoDesfecho(d: Desfecho, t: (texto: string) => string): string {
  switch (d) {
    case "enviada":
      return t("Enviada");
    case "falhou":
      return t("Falhou");
    case "cancelada":
      return t("Cancelada");
    case "na_fila":
      return t("Na fila de envio");
  }
}

function rotuloDoMotivo(motivo: string | null, t: (texto: string) => string): string | null {
  switch (motivo) {
    case "cancelada_pelo_atendente":
      return t("cancelada na conversa");
    case "numero_desconectado":
      return t("o número estava desconectado");
    case "sem_acesso":
      return t("quem agendou não tem mais acesso");
    case "contato_anonimizado":
      return t("contato anonimizado");
    default:
      return motivo;
  }
}

const chave = (conversationId: string) => ["mensagens-agendadas", conversationId] as const;

function useAgendamentos(conversationId: string) {
  return useQuery({
    queryKey: chave(conversationId),
    queryFn: () =>
      apiClient.get<{ data: Agendamento[] }>(
        `/api/v1/mensagens-agendadas?conversation_id=${encodeURIComponent(conversationId)}`,
      ),
    staleTime: 0,
    retry: 3,
    refetchOnWindowFocus: true,
  });
}

/** Botão ao lado do Enviar, com o número de mensagens agendadas pendentes da conversa. */
/**
 * O estado de aberto mora no Composer. A porta garantida é o item do "+"
 * (AttachMenu), presente em qualquer largura; este botão só aparece quando a
 * LINHA do composer tem 28rem ou mais (container query, não breakpoint de
 * tela). Abaixo disso o ícone a mais quebra o placeholder em duas linhas — a
 * 375px no celular e também a 1280px com o painel do contato aberto, onde a
 * coluna fica estreita com a janela larga.
 *
 * O número é medido: com o botão, a largura útil do campo é a da linha menos
 * ~246px, e o placeholder pede 162px. A 1280px com o painel aberto a linha
 * mede 400px — exatamente 25rem, o limiar anterior, que deixou o botão
 * aparecer e o texto quebrar. 28rem deixa ~40px de folga.
 *
 * O diálogo continua montado aqui, então as duas portas abrem o mesmo.
 */
export function MensagensAgendadasBotao({
  conversationId,
  textoInicial,
  aberto,
  onAbertoChange,
}: {
  conversationId: string;
  textoInicial?: string;
  aberto: boolean;
  onAbertoChange: (v: boolean) => void;
}) {
  const t = useT();
  const consulta = useAgendamentos(conversationId);
  const pendentes = (consulta.data?.data ?? []).filter((a) => a.status === "agendada").length;

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="relative hidden shrink-0 @min-[28rem]:inline-flex"
        onClick={() => onAbertoChange(true)}
        aria-label={t("Mensagens agendadas")}
        title={t("Mensagens agendadas")}
        data-testid="botao-mensagens-agendadas"
      >
        <CalendarClock className="size-5" aria-hidden />
        {pendentes ? (
          <span className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-primary px-1 text-[10px] leading-4 text-primary-foreground">
            {pendentes}
          </span>
        ) : null}
      </Button>
      {aberto && (
        <MensagensAgendadasDialog conversationId={conversationId} textoInicial={textoInicial ?? ""} onOpenChange={onAbertoChange} />
      )}
    </>
  );
}

function MensagensAgendadasDialog({
  conversationId,
  textoInicial,
  onOpenChange,
}: {
  conversationId: string;
  textoInicial: string;
  onOpenChange: (v: boolean) => void;
}) {
  const t = useT();
  const tag = useTagDeIdioma();
  const qc = useQueryClient();
  const consulta = useAgendamentos(conversationId);
  const [relatorio, setRelatorio] = useState(false);
  const [editando, setEditando] = useState<Agendamento | "novo" | null>(null);

  const todos = consulta.data?.data ?? [];
  const pendentes = todos.filter((a) => a.status === "agendada");
  const historico = todos.filter((a) => a.status !== "agendada");
  const quando = (iso: string) => new Date(iso).toLocaleString(tag, { dateStyle: "short", timeStyle: "short" });
  const atualizar = () => qc.invalidateQueries({ queryKey: chave(conversationId) });

  async function cancelar(id: string) {
    try {
      await apiClient.delete(`/api/v1/mensagens-agendadas/${id}`);
      toast.success(t("Mensagem agendada cancelada."));
      await atualizar();
    } catch {
      toast.error(t("Não consegui cancelar o agendamento."));
    }
  }

  const titulo = editando
    ? editando === "novo"
      ? t("Criar agendamento")
      : t("Editar agendamento")
    : relatorio
      ? t("Relatório")
      : t("Mensagens agendadas");

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{titulo}</DialogTitle>
        </DialogHeader>

        {editando ? (
          <FormularioDeAgendamento
            key={editando === "novo" ? "novo" : editando.id}
            inicial={editando === "novo" ? undefined : editando}
            conversationId={conversationId}
            textoInicial={textoInicial}
            onCancelar={() => setEditando(null)}
            onSalvo={async () => {
              setEditando(null);
              await atualizar();
            }}
          />
        ) : (
          <div className="space-y-3">
            <div className="flex justify-end">
              <Button
                type="button"
                variant={relatorio ? "secondary" : "outline"}
                size="sm"
                aria-pressed={relatorio}
                onClick={() => setRelatorio((r) => !r)}
              >
                <History className="mr-1 size-4" aria-hidden />
                {relatorio ? t("Ocultar") : t("Relatório")}
              </Button>
            </div>

            {consulta.isPending ? (
              <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>
            ) : relatorio ? (
              historico.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("Nenhum envio agendado saiu desta conversa ainda.")}</p>
              ) : (
                <ul className="divide-y rounded-md border">
                  {historico.map((a) => {
                    const d = desfechoDoAgendamento(a);
                    const motivo = rotuloDoMotivo(a.motivo, t);
                    return (
                      <li key={a.id} className="flex items-center gap-3 p-3 text-sm">
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium">{a.title || a.body}</p>
                          <p className="text-xs text-muted-foreground">
                            {quando(a.scheduled_at)}
                            {motivo ? ` · ${motivo}` : ""}
                          </p>
                        </div>
                        <Badge variant={d.tom}>{rotuloDoDesfecho(d.desfecho, t)}</Badge>
                      </li>
                    );
                  })}
                </ul>
              )
            ) : pendentes.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("Nenhuma mensagem agendada nesta conversa.")}</p>
            ) : (
              <ul className="divide-y rounded-md border">
                {pendentes.map((a) => (
                  <li key={a.id} className="flex items-center gap-3 p-3 text-sm">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{a.title || a.body}</p>
                      <p className="text-xs text-muted-foreground">
                        {quando(a.scheduled_at)}
                        {a.se_desconectado === "cancelar" ? ` · ${t("cancela se o número estiver desconectado")}` : ""}
                      </p>
                    </div>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label={t("Editar agendamento")}
                      title={t("Editar agendamento")}
                      onClick={() => setEditando(a)}
                    >
                      <PencilSimple size={16} weight="regular" aria-hidden />
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label={t("Cancelar mensagem agendada")}
                      title={t("Cancelar mensagem agendada")}
                      onClick={() => void cancelar(a.id)}
                    >
                      <Trash size={16} weight="regular" aria-hidden />
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            {!relatorio && (
              <div className="flex justify-end">
                <Button type="button" onClick={() => setEditando("novo")}>
                  <Plus className="mr-1 size-4" aria-hidden /> {t("Adicionar")}
                </Button>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Data e hora no fuso do navegador, no formato dos campos `date` e `time`. */
function partesLocais(iso: string): { data: string; hora: string } {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return { data: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, hora: `${p(d.getHours())}:${p(d.getMinutes())}` };
}

/** Formulário de criação ou, quando recebe `inicial`, de edição (PATCH). */
function FormularioDeAgendamento({
  inicial,
  conversationId,
  textoInicial,
  onCancelar,
  onSalvo,
}: {
  inicial?: Agendamento;
  conversationId: string;
  textoInicial: string;
  onCancelar: () => void;
  onSalvo: () => Promise<void>;
}) {
  const t = useT();
  const inicio = inicial ? partesLocais(inicial.scheduled_at) : { data: "", hora: "" };
  const [titulo, setTitulo] = useState(inicial?.title ?? "");
  const [texto, setTexto] = useState(inicial ? inicial.body : textoInicial);
  const [data, setData] = useState(inicio.data);
  const [hora, setHora] = useState(inicio.hora);
  const [seDesconectado, setSeDesconectado] = useState<"esperar" | "cancelar">(inicial?.se_desconectado ?? "esperar");
  const [salvando, setSalvando] = useState(false);

  async function salvar() {
    if (!texto.trim()) return toast.error(t("Escreva a mensagem."));
    if (!data || !hora) return toast.error(t("Escolha a data e a hora."));
    // `new Date("AAAA-MM-DDTHH:mm")` lê no fuso do navegador: é a hora que a pessoa viu na tela.
    const quando = new Date(`${data}T${hora}`);
    if (quando.getTime() <= Date.now()) return toast.error(t("Escolha um horário no futuro."));

    setSalvando(true);
    const corpo = {
      title: titulo.trim() || null,
      body: texto,
      scheduled_at: quando.toISOString(),
      se_desconectado: seDesconectado,
    };
    try {
      if (inicial) {
        await apiClient.patch(`/api/v1/mensagens-agendadas/${inicial.id}`, corpo);
        toast.success(t("Agendamento atualizado."));
      } else {
        await apiClient.post("/api/v1/mensagens-agendadas", { ...corpo, conversation_id: conversationId });
        toast.success(t("Mensagem agendada."));
      }
      await onSalvo();
    } catch {
      toast.error(inicial ? t("Não consegui salvar a edição. Confira os campos.") : t("Não consegui criar o agendamento. Confira os campos."));
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
        <Label htmlFor="ag-texto">{t("Mensagem")}</Label>
        <Textarea id="ag-texto" value={texto} onChange={(e) => setTexto(e.target.value)} placeholder={t("Insira sua mensagem")} rows={4} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor="ag-data">{t("Data")}</Label>
          <Input id="ag-data" type="date" value={data} onChange={(e) => setData(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="ag-hora">{t("Hora")}</Label>
          <Input id="ag-hora" type="time" value={hora} onChange={(e) => setHora(e.target.value)} />
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="ag-desconectado">{t("Se o WhatsApp estiver desconectado na hora")}</Label>
        <select
          id="ag-desconectado"
          className="h-9 w-full rounded-md border bg-background px-2 text-sm"
          value={seDesconectado}
          onChange={(e) => setSeDesconectado(e.target.value === "cancelar" ? "cancelar" : "esperar")}
        >
          <option value="esperar">{t("Esperar reconectar e enviar")}</option>
          <option value="cancelar">{t("Cancelar este envio")}</option>
        </select>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancelar}>
          <X className="mr-1 size-4" aria-hidden /> {t("Cancelar")}
        </Button>
        <Button type="button" onClick={() => void salvar()} disabled={salvando}>
          {salvando ? t("Salvando…") : inicial ? t("Salvar") : t("Criar")}
        </Button>
      </div>
    </div>
  );
}
