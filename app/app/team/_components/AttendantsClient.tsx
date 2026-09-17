"use client";

import { useT } from "@/hooks/i18n/useT";
import { useMemo, useState } from "react";
import { FUSOS_OFERECIDOS } from "@/lib/tempo/fusos";

import {
  useAttendants,
  useRoutingConfig,
  useUpdateAvailability,
  useUpdateRouting,
  type AttendantAvailability,
} from "@/hooks/team/useAttendants";
import { estaDePlantao } from "@/lib/routing/eligibility";
import {
  ROUTING_MODES,
  type RoutingConfig,
  type ScheduleWindow,
} from "@/lib/schemas/routing";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Clock, Plus, Trash } from "@/lib/ui/icons";

const DOW_LABELS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

const MODE_LABELS: Record<(typeof ROUTING_MODES)[number], string> = {
  manual: "Manual (atendente puxa da fila)",
  round_robin: "Rodízio (distribui automático)",
};

interface Attendant {
  userId: string;
  name: string;
  email: string | null;
  availability: AttendantAvailability;
}

/**
 * ⚠️ JANELA VAZIA NÃO É "24/7" — a mesma coluna significa COISAS OPOSTAS nos dois
 * sistemas que a leem, e isto está medido em `lib/agenda/horarios-livres.ts:214`:
 *
 *   roteamento (`isWithinSchedule`)  ·  vazio = aceita conversa a qualquer hora
 *   agenda (horários livres)         ·  vazio = nada publicado ⇒ ZERO horário
 *
 * Esta tela dizia só o primeiro. Quem lia "24/7" concluía, com razão, que estava
 * tudo configurado — e a Agenda, na tela ao lado, dizia "você ainda não publicou
 * seus horários" sobre a MESMA linha do banco. O dono do produto passou por
 * aqui, leu 24/7 e foi procurar o problema em outro lugar.
 *
 * "Não publicado" é o rótulo certo porque nomeia o que FALTA. O outro efeito —
 * o roteamento aceitando a qualquer hora — é dito por extenso no diálogo, onde
 * há espaço para as duas metades.
 */
function summarizeSchedule(windows: ScheduleWindow[], t: (texto: string) => string): string {
  if (windows.length === 0) return t("Não publicado");
  return windows.map((w) => `${t(DOW_LABELS[w.dow] ?? "")} ${w.start}–${w.end}`).join(", ");
}

/**
 * O selo diz DE PLANTÃO AGORA — não "o navegador está aberto".
 *
 * Ele lia `is_available && !isHeartbeatStale(...)`, e as duas metades mentiam:
 * o sinal de vida nunca era emitido por ninguém, então o selo virava "Offline"
 * ~15 min depois de qualquer clique e ficava assim para sempre; e a jornada
 * publicada, que é o que de fato decide, não entrava na conta.
 *
 * Agora é `estaDePlantao` — a MESMA conta do roteador, sem a capacidade. A tela
 * e o motor passam a dizer a mesma coisa sobre a mesma pessoa.
 *
 * "Fora do horário" ganha selo próprio porque é um terceiro estado, e confundi-lo
 * com "desligado" é o que fazia o operador ir procurar defeito: quem está com a
 * chave ligada às 22h não desligou nada — a jornada dele acabou, e volta amanhã.
 */
function StatusBadge({ attendant, now }: { attendant: Attendant; now: Date }) {
  const t = useT();
  const a = attendant.availability;
  const ligado = !!a?.is_available;
  if (estaDePlantao({ isAvailable: ligado, schedule: a?.schedule }, now)) {
    return <Badge variant="default">{t("De plantão")}</Badge>;
  }
  if (ligado) {
    return (
      <Badge variant="outline" className="text-muted-foreground">
        {t("Fora do horário")}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-muted-foreground">
      {t("Desligado")}
    </Badge>
  );
}

/** Editor de janela de horário (schedule tz-aware) de um atendente. */
function ScheduleDialog({
  attendant,
  open,
  onOpenChange,
  onSave,
  isPending,
}: {
  attendant: Attendant;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSave: (windows: ScheduleWindow[], timezone: string) => void;
  isPending: boolean;
}) {
  const t = useT();
  const initial = attendant.availability?.schedule;
  const [timezone, setTimezone] = useState(initial?.timezone || "America/Sao_Paulo");
  const [windows, setWindows] = useState<ScheduleWindow[]>(initial?.windows ?? []);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Horário de")} {attendant.name}</DialogTitle>
          <DialogDescription>
            {t(
              "Sem janelas, o roteamento aceita conversa a qualquer hora — mas a Agenda não oferece NENHUM horário para marcar. Adicione janelas para publicar seus horários de atendimento.",
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="tz">{t("Fuso horário")}</Label>
            {/* Mesma razão do painel anti-banimento, e aqui o custo é maior:
                este fuso é lido por `localMoment`, que LANÇA num fuso inexistente
                — e o atendente com agenda quebrada nunca fica elegível, sem que
                nada na tela diga por quê. */}
            <select
              id="tz"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            >
              {FUSOS_OFERECIDOS.map((f) => (
                <option key={f.codigo} value={f.codigo}>
                  {f.rotulo} — {f.codigo}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            {windows.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("Nenhuma janela publicada — ninguém consegue marcar com esta pessoa.")}
              </p>
            ) : null}
            {windows.map((w, i) => (
              <div key={i} className="flex items-center gap-2">
                <Select
                  value={String(w.dow)}
                  onValueChange={(v) =>
                    setWindows((ws) =>
                      ws.map((x, j) => (j === i ? { ...x, dow: Number(v) } : x)),
                    )
                  }
                >
                  <SelectTrigger className="w-[90px]" aria-label="Dia da semana">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DOW_LABELS.map((d, idx) => (
                      <SelectItem key={idx} value={String(idx)}>
                        {d}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  type="time"
                  value={w.start}
                  aria-label={t("Início")}
                  onChange={(e) =>
                    setWindows((ws) =>
                      ws.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)),
                    )
                  }
                />
                <span className="text-muted-foreground">–</span>
                <Input
                  type="time"
                  value={w.end}
                  aria-label="Fim"
                  onChange={(e) =>
                    setWindows((ws) =>
                      ws.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)),
                    )
                  }
                />
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Remover janela"
                  onClick={() => setWindows((ws) => ws.filter((_, j) => j !== i))}
                >
                  <Trash size={18} />
                </Button>
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setWindows((ws) => [...ws, { dow: 1, start: "08:00", end: "18:00" }])
              }
            >
              <Plus size={16} className="mr-1" /> Adicionar janela
            </Button>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button disabled={isPending} onClick={() => onSave(windows, timezone)}>
            Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RoutingCard({ canManage }: { canManage: boolean }) {
  const t = useT();
  const { data, isLoading, isError } = useRoutingConfig();
  const update = useUpdateRouting();
  const config = data?.data;

  const [draft, setDraft] = useState<RoutingConfig | null>(null);
  const current = draft ?? config ?? null;

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-40" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-9 w-full max-w-sm" />
        </CardContent>
      </Card>
    );
  }
  if (isError || !current) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-sm text-destructive">{t("Erro ao carregar a configuração de roteamento.")}</p>
        </CardContent>
      </Card>
    );
  }

  const dirty =
    !!config &&
    (current.mode !== config.mode ||
      current.max_retries !== config.max_retries ||
      current.backoff_seconds !== config.backoff_seconds);

  const set = (patch: Partial<RoutingConfig>) => setDraft({ ...current, ...patch });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Modo de roteamento")}</CardTitle>
        <CardDescription>
          {t("Como as conversas novas são distribuídas entre os atendentes da organização.")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label>Modo</Label>
            <Select
              value={current.mode}
              disabled={!canManage}
              onValueChange={(v) => set({ mode: v as RoutingConfig["mode"] })}
            >
              <SelectTrigger aria-label="Modo de roteamento">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROUTING_MODES.map((m) => (
                  <SelectItem key={m} value={m}>
                    {MODE_LABELS[m]}
                  </SelectItem>
                ))}
                {/* 'load' (balanceamento por carga) é pós-MVP: a API rejeita — desabilitado. */}
                <SelectItem value="load" disabled>
                  Balanceamento por carga (em breve)
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="max_retries">{t("Tentativas máx.")}</Label>
            <Input
              id="max_retries"
              type="number"
              min={0}
              max={20}
              disabled={!canManage}
              value={current.max_retries}
              onChange={(e) => set({ max_retries: Number(e.target.value) })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="backoff">Backoff (s)</Label>
            <Input
              id="backoff"
              type="number"
              min={1}
              max={3600}
              disabled={!canManage}
              value={current.backoff_seconds}
              onChange={(e) => set({ backoff_seconds: Number(e.target.value) })}
            />
          </div>
        </div>
        {canManage ? (
          <div className="flex sm:justify-end">
            <Button
              disabled={!dirty || update.isPending}
              onClick={() => update.mutate(current, { onSuccess: () => setDraft(null) })}
              className="w-full sm:w-auto"
            >
              Salvar
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

interface Props {
  canManage: boolean;
}

export function AttendantsClient({ canManage }: Props) {
  const t = useT();
  const avail = useAttendants();
  const patch = useUpdateAvailability();
  const [scheduleFor, setScheduleFor] = useState<Attendant | null>(null);
  const now = useMemo(() => new Date(), []);

  const attendants: Attendant[] = useMemo(
    () =>
      (avail.data?.data ?? []).map((a) => ({
        userId: a.user_id,
        name: a.name ?? a.email ?? a.user_id.slice(0, 8),
        email: a.email,
        availability: a,
      })),
    [avail.data],
  );

  const isLoading = avail.isLoading;
  const isError = avail.isError;

  return (
    <div className="space-y-6">
      <RoutingCard canManage={canManage} />

      <div className="rounded-md border">
        <div className="border-b px-4 py-3" data-testid="atendentes-e-horarios">
          <h2 className="text-sm font-semibold">{t("Atendentes e horários de atendimento")}</h2>
          <p className="text-xs text-muted-foreground">
            {/*
              A frase NOMEIA o que a coluna "Horário" faz, e isso é o conserto —
              não enfeite. Esta é a única tela do produto onde se publica a
              jornada, e ela se anunciava como "status, carga e capacidade": quem
              procurava "meus horários" passava por cima. A Agenda manda para cá
              (`/app/team?aba=atendimento`) quando ninguém publicou nada, e o
              destino tinha de dizer que é o lugar certo.
            */}
            {t(
              "Status, carga e capacidade de cada atendente — e a jornada semanal que decide os horários oferecidos na Agenda. Sem ela ninguém consegue marcar.",
            )}
          </p>
        </div>

        {isLoading ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : isError ? (
          <p className="p-4 text-sm text-destructive">Erro ao carregar atendentes.</p>
        ) : attendants.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            {t("Nenhum atendente na organização. Convide membros com papel de atendente ou superior.")}
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("Atendente")}</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>{t("Carga")}</TableHead>
                <TableHead>{t("Capacidade")}</TableHead>
                <TableHead>{t("Horário")}</TableHead>
                {canManage ? <TableHead className="w-[120px]">{t("Disponível")}</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {attendants.map((a) => {
                const capacity = a.availability?.capacity ?? 5;
                const load = a.availability?.current_load ?? 0;
                const windows = a.availability?.schedule?.windows ?? [];
                return (
                  <TableRow key={a.userId}>
                    <TableCell>
                      <div className="font-medium">{a.name}</div>
                      {a.email ? (
                        <div className="text-xs text-muted-foreground">{a.email}</div>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <StatusBadge attendant={a} now={now} />
                    </TableCell>
                    <TableCell>
                      <span className={load >= capacity ? "font-medium text-destructive" : ""}>
                        {load}
                      </span>
                    </TableCell>
                    <TableCell>
                      {canManage ? (
                        <Input
                          type="number"
                          min={1}
                          max={1000}
                          defaultValue={capacity}
                          className="h-8 w-20"
                          aria-label={`Capacidade de ${a.name}`}
                          onBlur={(e) => {
                            const next = Number(e.target.value);
                            if (Number.isInteger(next) && next >= 1 && next !== capacity) {
                              patch.mutate({ userId: a.userId, patch: { capacity: next } });
                            }
                          }}
                        />
                      ) : (
                        capacity
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      <div className="flex items-center gap-2">
                        <span>{summarizeSchedule(windows, t)}</span>
                        {canManage ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            aria-label={`Editar horário de ${a.name}`}
                            onClick={() => setScheduleFor(a)}
                          >
                            <Clock size={16} />
                          </Button>
                        ) : null}
                      </div>
                    </TableCell>
                    {canManage ? (
                      <TableCell>
                        <Switch
                          checked={!!a.availability?.is_available}
                          aria-label={`Disponibilidade de ${a.name}`}
                          onCheckedChange={(v) =>
                            patch.mutate({ userId: a.userId, patch: { is_available: v } })
                          }
                        />
                      </TableCell>
                    ) : null}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>

      {scheduleFor ? (
        <ScheduleDialog
          attendant={scheduleFor}
          open={!!scheduleFor}
          onOpenChange={(o) => !o && setScheduleFor(null)}
          isPending={patch.isPending}
          onSave={(windows, timezone) =>
            patch.mutate(
              { userId: scheduleFor.userId, patch: { schedule: { timezone, windows } } },
              { onSuccess: () => setScheduleFor(null) },
            )
          }
        />
      ) : null}
    </div>
  );
}
