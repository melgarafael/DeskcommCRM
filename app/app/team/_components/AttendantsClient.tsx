"use client";

import { useT } from "@/hooks/i18n/useT";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useMemo, useState } from "react";
import { FUSOS_OFERECIDOS, fusoOferecidoOuPadrao } from "@/lib/tempo/fusos";

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
import { Clock, Copy, Plus, Trash } from "@/lib/ui/icons";
import {
  copiarParaDiasUteis,
  podeCopiarParaDiasUteis,
  resumoDaJornada,
  ROTULOS_DOS_DIAS,
} from "@/lib/agenda/editor-de-jornada";

/**
 * Os rótulos da semana vêm de `lib/agenda/editor-de-jornada` — a MESMA fonte do
 * resumo do que foi publicado. Duas listas aqui e ali seria o segundo rótulo
 * para o mesmo dia, que é a segunda régua do mesmo número.
 */
const DOW_LABELS: readonly string[] = ROTULOS_DOS_DIAS;

const MODE_LABELS: Record<(typeof ROUTING_MODES)[number], string> = {
  manual: "Manual (atendente puxa da fila)",
  round_robin: "Rodízio (distribui automático)",
  load: "Menor carga (quem tem menos conversas na mão)",
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

/**
 * O SEGUNDO SELO DA MESMA CÉLULA: "tem alguém aí?" (issue #996).
 *
 * O selo de cima diz se a pessoa ESTÁ DE PLANTÃO — decisão dela, limitada pela
 * jornada. Este diz se o NAVEGADOR dela está aberto agora, que é outra coisa e
 * mora em outra coluna (`last_heartbeat_at`). Os dois lado a lado é o ponto: o
 * operador que via "De plantão" e ligava para a pessoa sem resposta passa a
 * enxergar as duas metades na mesma linha, sem que uma apague a outra.
 *
 * O valor vem do SERVIDOR (`present`, derivado com o prazo de
 * `lib/atendimento/presenca.ts`), e não de uma conta feita aqui: recalculá-lo
 * nesta tela criaria a segunda régua do mesmo número — exatamente o defeito que
 * o #720 mediu entre esta tela e o roteador. O carimbo exato vai no `title`
 * para quem precisa do "quando", e a hora aparece ao lado do selo.
 *
 * ⚠️ Presença NÃO é plantão e não desliga plantão: este selo é leitura pura.
 */
function PresenceBadge({ attendant }: { attendant: Attendant }) {
  const t = useT();
  const tagDoIdioma = useTagDeIdioma();
  const carimbo = attendant.availability?.last_heartbeat_at ?? null;
  const presente = !!attendant.availability?.present;
  const hora =
    carimbo === null
      ? null
      : new Date(carimbo).toLocaleTimeString(tagDoIdioma, { hour: "2-digit", minute: "2-digit" });

  if (hora === null) {
    return (
      <Badge variant="neutral" data-testid="presenca" data-presente="nao">
        {t("Sem sinal de tela")}
      </Badge>
    );
  }

  return (
    <span className="inline-flex items-center gap-2">
      {presente ? (
        <Badge variant="success" data-testid="presenca" data-presente="sim" title={carimbo ?? ""}>
          {t("Com a tela aberta")}
        </Badge>
      ) : (
        <Badge variant="neutral" data-testid="presenca" data-presente="nao" title={carimbo ?? ""}>
          {t("Sem sinal de tela")}
        </Badge>
      )}
      <span className="text-xs text-muted-foreground">
        {t("último sinal às")} {hora}
      </span>
    </span>
  );
}

/**
 * Editor de janela de horário (schedule tz-aware) de um atendente.
 *
 * Duas peças da issue #2312 moram aqui, e as duas são respostas ao MESMO
 * defeito — a pessoa achava que preencheu a semana e só a segunda foi gravada:
 *
 *   o BOTÃO copia as faixas do dia-modelo para os outros dias úteis
 *   (`lib/agenda/editor-de-jornada`) — a semana deixa de ser digitação;
 *
 *   o RESUMO depois de salvar mostra o que SAIU GRAVADO, lido do retorno da
 *   gravação, e o diálogo SÓ FECHA quando a pessoa pede — fechar no sucesso
 *   transformaria o resumo num toast que ninguém lê, que é o mesmo silêncio
 *   do bug.
 */
export function ScheduleDialog({
  attendant,
  open,
  onOpenChange,
  onSave,
  isPending,
  organizationTimezone,
}: {
  attendant: Attendant;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Devolve as janelas que o SERVIDOR guardou — é daqui que o resumo lê. */
  onSave: (windows: ScheduleWindow[], timezone: string) => Promise<ScheduleWindow[]>;
  isPending: boolean;
  organizationTimezone?: string;
}) {
  const t = useT();
  const initial = attendant.availability?.schedule;
  const defaultTimezone = fusoOferecidoOuPadrao(organizationTimezone);
  const [timezone, setTimezone] = useState(initial?.timezone || defaultTimezone);
  const [windows, setWindows] = useState<ScheduleWindow[]>(initial?.windows ?? []);
  /**
   * O que o SERVIDOR guardou no último "Salvar", lido do RETORNO da gravação.
   * `null` enquanto nada foi publicado nesta abertura do diálogo.
   *
   * Não é uma cópia de `windows`: o formulário é o rascunho, e o rascunho pode
   * divergir do banco (janela removida, limite da rota, outra pessoa mexendo).
   * O resumo existe justamente para mostrar a diferença — se ele lesse o
   * formulário, repetiria o defeito da #2312 com outra roupa.
   */
  const [gravacao, setGravacao] = useState<{
    rascunho: ScheduleWindow[];
    timezone: string;
    janelas: ScheduleWindow[];
  } | null>(null);
  // O resumo vale para o rascunho que foi gravado. Mexeu depois (outra faixa,
  // o botão de copiar, o fuso)? O resumo sai e o "Salvar" volta — senão a
  // edição sumiria no "Fechar" sem aviso, que é o defeito da #2312 de novo.
  const publicado =
    gravacao && gravacao.rascunho === windows && gravacao.timezone === timezone
      ? gravacao.janelas
      : null;
  /** Desligado quando não há o que copiar ou quando a cópia estouraria a rota. */
  const podeCopiar = podeCopiarParaDiasUteis(windows);

  async function salvar() {
    try {
      setGravacao({ rascunho: windows, timezone, janelas: await onSave(windows, timezone) });
    } catch {
      // O erro já virou toast no hook (`showApiError`) e o diálogo fica ABERTO:
      // fechar depois de uma gravação que falhou seria dizer que deu certo.
    }
  }

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
              <div key={i} data-testid="janela" data-dow={w.dow} className="flex items-center gap-2">
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
            {/*
              O DEFEITO DA #2312 EM UMA LINHA: preenchia-se a segunda e o
              editor deixava a pessoa acreditar que tinha publicado a semana.
              O botão copia as faixas do dia-modelo para os outros dias úteis,
              no RASCUNHO — ainda dá para ajustar ou cancelar antes de salvar.
              Sem janela nenhuma não há o que copiar, e passar do limite da rota
              (50) viraria erro no salvamento, então os dois casos desligam o
              botão em vez de prometer o que não vão entregar.
            */}
            <Button
              variant="outline"
              size="sm"
              disabled={!podeCopiar}
              title={
                podeCopiar || windows.length === 0
                  ? undefined
                  : t("Limite de 50 janelas por atendente: remova algumas antes de copiar.")
              }
              onClick={() => setWindows((ws) => copiarParaDiasUteis(ws))}
            >
              <Copy size={16} className="mr-1" />{" "}
              {t("Copiar estes horários para os outros dias úteis")}
            </Button>
          </div>
        </div>

        {/*
          O RESUMO LÊ O RETORNO DA GRAVAÇÃO (`publicado`), nunca o formulário
          acima. É a outra metade do mesmo defeito: a tela dizia uma semana e o
          banco guardava um dia. Aqui a pessoa vê o que o banco guardou — e o
          rodapé vira "Fechar" justamente para ela conferir ANTES de sair, não
          depois, no toast que ninguém lê.
        */}
        {/* A região de status fica SEMPRE montada e o resumo entra dentro dela:
            leitor de tela anuncia mudança numa região que já existia, não uma
            região que nasce já cheia. */}
        <div role="status">
          {publicado ? (
            <div data-testid="resumo-publicado" className="space-y-1 rounded-md border p-3">
              <p className="text-sm font-medium">{t("Publicado")}</p>
              <ul className="text-sm text-muted-foreground">
                {resumoDaJornada(publicado, t).map((linha) => (
                  <li key={linha}>{linha}</li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">
                {t("É isto que ficou gravado — confira os dias e os horários antes de sair.")}
              </p>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          {publicado ? (
            <Button onClick={() => onOpenChange(false)}>{t("Fechar")}</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancelar
              </Button>
              <Button disabled={isPending} onClick={salvar}>
                Salvar
              </Button>
            </>
          )}
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
  organizationTimezone?: string;
}

export function AttendantsClient({ canManage, organizationTimezone }: Props) {
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
                      <div className="flex flex-col items-start gap-1.5">
                        <StatusBadge attendant={a} now={now} />
                        <PresenceBadge attendant={a} />
                      </div>
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
                            {/* Rótulo visível (item opcional da #2312): achar o
                                editor era o primeiro problema — ele era só um
                                ícone solto na coluna. O `aria-label` fica, é ele
                                que a automação e o leitor de tela usam. */}
                            <Clock size={16} />
                            <span className="ml-1 hidden lg:inline">{t("Editar")}</span>
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
          organizationTimezone={organizationTimezone}
          onSave={async (windows, timezone) => {
            // `mutateAsync`, e não `mutate`: o resumo lê o RETORNO da gravação
            // (issue #2312) — fechar o diálogo no `onSuccess` era exatamente o
            // que impedia a pessoa de conferir o que ficou publicado.
            const resposta = await patch.mutateAsync({
              userId: scheduleFor.userId,
              patch: { schedule: { timezone, windows } },
            });
            return resposta?.data?.schedule?.windows ?? [];
          }}
        />
      ) : null}
    </div>
  );
}
