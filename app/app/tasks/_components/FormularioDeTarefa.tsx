"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/hooks/i18n/useT";
import type {
  NovaTarefa,
  PrioridadeDaTarefa,
  SituacaoDaTarefa,
  Tarefa,
} from "@/lib/tarefas/tipos";

interface Props {
  aberto: boolean;
  aoMudarAbertura: (aberto: boolean) => void;
  /** `null` = criar. */
  tarefa?: Tarefa | null;
  /** `YYYY-MM-DD` vindo do clique numa célula do calendário. */
  prazoSugerido?: string;
  aoSalvar: (entrada: NovaTarefa) => Promise<unknown>;
  leadId?: string | null;
  contactId?: string | null;
}

/**
 * ISO → os dois campos que a pessoa preenche, no fuso DELA.
 *
 * ⚠️ `toISOString().slice(0,10)` para a data era o do original, e ele lê o dia
 * em UTC: 31/12 às 21h em Brasília voltava como 01/01. A pessoa abriria para
 * editar e veria outro dia.
 */
function separaPrazo(iso: string | null | undefined): { dia: string; hora: string } {
  if (!iso) return { dia: "", hora: "09:00" };
  const d = new Date(iso);
  const dois = (n: number) => String(n).padStart(2, "0");
  return {
    dia: `${d.getFullYear()}-${dois(d.getMonth() + 1)}-${dois(d.getDate())}`,
    hora: `${dois(d.getHours())}:${dois(d.getMinutes())}`,
  };
}

export function FormularioDeTarefa({
  aberto,
  aoMudarAbertura,
  tarefa,
  prazoSugerido,
  aoSalvar,
  leadId,
  contactId,
}: Props) {
  const t = useT();
  const editando = Boolean(tarefa);

  // ⚠️ O ESTADO NASCE DAS PROPS, e não de um `useEffect` que dá setState no
  // corpo — que era o do original e o que o `react-hooks/set-state-in-effect`
  // acusa. Quem garante que o formulário reflete a tarefa certa é a `key` que o
  // pai passa: ela muda a cada abertura, então o componente REMONTA e o
  // inicializador roda de novo. Efeito para sincronizar props com estado é
  // render em cascata e uma janela em que a tela mostra a tarefa anterior.
  const prazo = separaPrazo(tarefa?.due_date);
  const [titulo, setTitulo] = useState(tarefa?.title ?? "");
  const [descricao, setDescricao] = useState(tarefa?.description ?? "");
  const [dia, setDia] = useState(tarefa?.due_date ? prazo.dia : (prazoSugerido ?? ""));
  const [hora, setHora] = useState(tarefa?.due_date ? prazo.hora : "09:00");
  const [prioridade, setPrioridade] = useState<PrioridadeDaTarefa>(tarefa?.priority ?? "medium");
  const [situacao, setSituacao] = useState<SituacaoDaTarefa>(tarefa?.status ?? "pending");
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  async function enviar(e: React.FormEvent) {
    e.preventDefault();
    if (!titulo.trim()) {
      setErro(t("Escreva um título para a tarefa."));
      return;
    }
    // Prazo é OPCIONAL — a coluna é nullable de propósito (migration 0210).
    // Sem dia não há hora que valha, e uma hora solta viraria "hoje às 9h" sem
    // ninguém ter pedido.
    const prazo = dia ? new Date(`${dia}T${hora || "00:00"}:00`).toISOString() : null;

    setSalvando(true);
    setErro(null);
    try {
      await aoSalvar({
        title: titulo.trim(),
        description: descricao.trim() || null,
        due_date: prazo,
        priority: prioridade,
        status: situacao,
        lead_id: tarefa?.lead_id ?? leadId ?? null,
        contact_id: tarefa?.contact_id ?? contactId ?? null,
      });
      aoMudarAbertura(false);
    } catch (falha) {
      // A mensagem do servidor quando ela existe: ela nomeia o campo recusado.
      setErro(falha instanceof Error ? falha.message : t("Não foi possível salvar a tarefa."));
    } finally {
      setSalvando(false);
    }
  }

  return (
    <Dialog open={aberto} onOpenChange={aoMudarAbertura}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{editando ? t("Editar tarefa") : t("Nova tarefa")}</DialogTitle>
        </DialogHeader>

        <form onSubmit={enviar} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="tarefa-titulo">{t("O que precisa ser feito")}</Label>
            <Input
              id="tarefa-titulo"
              value={titulo}
              onChange={(e) => setTitulo(e.target.value)}
              placeholder={t("Ex.: ligar de volta para fechar a proposta")}
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="tarefa-descricao">{t("Detalhes")}</Label>
            <Textarea
              id="tarefa-descricao"
              rows={2}
              className="resize-none"
              value={descricao}
              onChange={(e) => setDescricao(e.target.value)}
              placeholder={t("O que você vai querer lembrar quando chegar a hora")}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="tarefa-dia">{t("Prazo")}</Label>
              <Input
                id="tarefa-dia"
                type="date"
                value={dia}
                onChange={(e) => setDia(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tarefa-hora">{t("Horário")}</Label>
              <Input
                id="tarefa-hora"
                type="time"
                value={hora}
                disabled={!dia}
                onChange={(e) => setHora(e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="tarefa-prioridade">{t("Prioridade")}</Label>
              <Select
                value={prioridade}
                onValueChange={(v) => setPrioridade(v as PrioridadeDaTarefa)}
              >
                <SelectTrigger id="tarefa-prioridade">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">{t("Baixa")}</SelectItem>
                  <SelectItem value="medium">{t("Média")}</SelectItem>
                  <SelectItem value="high">{t("Alta")}</SelectItem>
                  <SelectItem value="urgent">{t("Urgente")}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="tarefa-situacao">{t("Situação")}</Label>
              <Select value={situacao} onValueChange={(v) => setSituacao(v as SituacaoDaTarefa)}>
                <SelectTrigger id="tarefa-situacao">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="pending">{t("Pendente")}</SelectItem>
                  <SelectItem value="in_progress">{t("Em andamento")}</SelectItem>
                  <SelectItem value="done">{t("Concluída")}</SelectItem>
                  <SelectItem value="cancelled">{t("Cancelada")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {erro ? (
            <p role="alert" className="rounded-md bg-destructive/10 p-2 text-xs font-medium text-destructive">
              {erro}
            </p>
          ) : null}

          <DialogFooter className="pt-2">
            <Button
              type="button"
              variant="ghost"
              disabled={salvando}
              onClick={() => aoMudarAbertura(false)}
            >
              {t("Cancelar")}
            </Button>
            <Button type="submit" disabled={salvando}>
              {salvando ? t("Salvando…") : t("Salvar")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
