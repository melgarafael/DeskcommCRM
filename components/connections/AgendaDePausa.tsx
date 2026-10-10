"use client";
/**
 * Agendar pausa — a janela de manutenção de conexões (#2388).
 *
 * ─── O que esta tela faz, e o que ela não faz ───────────────────────────────
 *
 * Guarda a INTENÇÃO (início, fim, escopo) numa linha e sai do caminho. Quem
 * pausa e quem retoma é o cron `channel-pause-scheduler`, pela MESMA escrita da
 * pausa manual: esta tela não desliga nada na hora do clique, e é de propósito
 * — a retomada automática só existe se a pausa for um registro com horário,
 * não um clique solto.
 *
 * ─── Hora de PAREDE na org, instante absoluto no banco ──────────────────────
 *
 * O operador diz "das 23h às 2h" no fuso DA ORGANIZAÇÃO (o `fuso` vem do GET,
 * lido do banco — não do navegador). A conversão para instante acontece aqui,
 * com `instanteDe` de `lib/agenda/fuso`, que resolve a hora que não existe nem
 * que repete na virada do horário de verão (critério 7): a janela atravessa a
 * virada e o cron compara instantes, sem saber o que é fuso.
 *
 * ─── Mensagem nenhuma se perde (critério 1) ──────────────────────────────────
 *
 * Pausar é a MESMA chave `disabled` da pausa manual: a entrega continua sendo
 * gravada na inbox durante a janela e volta na retomada (lei do #2318). É o que
 * a linha de aviso abaixo da tela promete — e o que `canal-pausado.test.ts` +
 * o cron de retomada garantem nos dois lados.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { instanteDe } from "@/lib/agenda/fuso";
import { nomeDoCanal } from "@/lib/channels/estado";
import { useT } from "@/hooks/i18n/useT";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";

/** O operador escolhe pelo NOME da conexão — o id é só o valor que desce à API. */
type CanalDaLista = { id: string; display_name?: string | null; phone_number?: string | null };

type AgendaVisivel = {
  id: string;
  channel_session_id: string | null;
  starts_at: string;
  ends_at: string;
  status: string;
};

const TODOS = "todos";

/** `2026-10-10T03:00` (parede) → instante naquele fuso. Inválido = `null`. */
export function paredeParaInstante(valor: string, fuso: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(valor);
  if (!m) return null;
  return instanteDe(
    { ano: Number(m[1]), mes: Number(m[2]), dia: Number(m[3]), hora: Number(m[4]), minuto: Number(m[5]) },
    fuso,
  ).toISOString();
}

export function AgendaDePausa({ canais }: { canais: CanalDaLista[] }) {
  const t = useT();
  const tag = useTagDeIdioma();
  const qc = useQueryClient();
  const [aberto, setAberto] = useState(false);
  const [inicio, setInicio] = useState("");
  const [fim, setFim] = useState("");
  const [escopo, setEscopo] = useState<string>(TODOS);
  const [salvando, setSalvando] = useState(false);
  const [cancelando, setCancelando] = useState<string | null>(null);

  const janelas = useQuery({
    queryKey: ["channel-schedules"],
    enabled: aberto,
    queryFn: () =>
      apiClient
        .get<{ data: { fuso: string; agendas: AgendaVisivel[] } }>("/api/v1/channel-schedules")
        .then((r) => r.data),
  });

  const fuso = janelas.data?.fuso ?? "America/Sao_Paulo";
  const agendas = janelas.data?.agendas ?? [];
  const vivas = agendas.filter((a) => a.status === "scheduled" || a.status === "running");
  // A lista mostra a hora no MESMO fuso em que foi digitada (o da organização),
  // não no do navegador: senão quem agenda de outro fuso lê outra hora.
  const quando = new Intl.DateTimeFormat(tag, { dateStyle: "short", timeStyle: "short", timeZone: fuso });
  const alvoDa = (a: AgendaVisivel): string => {
    if (a.channel_session_id === null) return t("Para todas as conexões");
    const canal = canais.find((c) => c.id === a.channel_session_id);
    return canal ? nomeDoCanal(canal, t) : t("Número sem nome");
  };

  async function agendar(): Promise<void> {
    const starts_at = paredeParaInstante(inicio, fuso);
    const ends_at = paredeParaInstante(fim, fuso);
    if (!starts_at || !ends_at) {
      toast.error(t("Informe os dois horários da janela."));
      return;
    }
    if (Date.parse(ends_at) <= Date.parse(starts_at)) {
      toast.error(t("O fim precisa ser depois do início."));
      return;
    }
    setSalvando(true);
    try {
      await apiClient.post("/api/v1/channel-schedules", {
        starts_at,
        ends_at,
        channel_session_id: escopo === TODOS ? null : escopo,
      });
      toast.success(t("Janela agendada: a pausa e a retomada acontecem sozinhas."));
      setAberto(false);
      setInicio("");
      setFim("");
      setEscopo(TODOS);
      await qc.invalidateQueries({ queryKey: ["channel-schedules"] });
    } catch (err) {
      // A recusa do servidor já diz o que fazer ("precisa começar no futuro"…).
      toast.error(err instanceof ApiError ? t(err.message) : t("Não foi possível agendar a janela."));
    } finally {
      setSalvando(false);
    }
  }

  async function cancelar(id: string): Promise<void> {
    setCancelando(id);
    try {
      await apiClient.delete(`/api/v1/channel-schedules/${id}`);
      toast.success(t("Janela cancelada. O que ela já pausou continua pausado."));
      await qc.invalidateQueries({ queryKey: ["channel-schedules"] });
    } catch (err) {
      toast.error(err instanceof ApiError ? t(err.message) : t("Não foi possível cancelar a janela."));
    } finally {
      setCancelando(null);
    }
  }

  return (
    <Dialog open={aberto} onOpenChange={setAberto}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          {t("Agendar pausa")}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("Janela de manutenção")}</DialogTitle>
          <DialogDescription>
            {t(
              "A pausa e a retomada acontecem sozinhas no horário marcado. A mensagem que chegar durante a pausa fica gravada e volta na retomada.",
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="agenda-inicio">{t("A pausa começa (hora local)")}</Label>
            <Input
              id="agenda-inicio"
              type="datetime-local"
              value={inicio}
              onChange={(e) => setInicio(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="agenda-fim">{t("A pausa termina (hora local)")}</Label>
            <Input id="agenda-fim" type="datetime-local" value={fim} onChange={(e) => setFim(e.target.value)} />
          </div>
          <p className="text-xs text-muted-foreground">
            {t("Fuso da organização")}: {fuso}
          </p>
          <div className="grid gap-1.5">
            <Label>{t("Escopo")}</Label>
            <Select value={escopo} onValueChange={setEscopo}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={TODOS}>{t("Para todas as conexões")}</SelectItem>
                {canais.map((canal) => (
                  <SelectItem key={canal.id} value={canal.id}>
                    {nomeDoCanal(canal, t)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {vivas.length > 0 && (
          <div className="grid gap-2">
            <p className="text-sm font-medium">{t("Janelas agendadas")}</p>
            <ul className="grid gap-1.5">
              {vivas.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-2 text-sm">
                  <span>
                    {quando.format(new Date(a.starts_at))} — {quando.format(new Date(a.ends_at))} · {alvoDa(a)}
                    {a.status === "running" ? ` · ${t("Em andamento")}` : ""}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={cancelando === a.id}
                    onClick={() => cancelar(a.id)}
                  >
                    {t("Cancelar janela")}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => setAberto(false)}>
            {t("Fechar")}
          </Button>
          <Button onClick={agendar} disabled={salvando}>
            {salvando ? t("Agendando…") : t("Agendar")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
