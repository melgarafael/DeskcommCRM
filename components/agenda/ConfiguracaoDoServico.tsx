"use client";
import * as React from "react";
import { randomId } from "@/lib/random-id";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { apiClient } from "@/lib/api/client";
import { configuracaoDoServicoSchema, type ConfiguracaoDoServico as Config, type HorarioDoServico } from "@/lib/agenda/servicos/regras";
import type { DadosDoServico, DisponibilidadeDoServico } from "@/lib/agenda/servicos/consulta";
import { MOTIVOS_DO_SERVICO } from "@/lib/agenda/servicos/motivos";
import { instanteDe, diaLocalISO } from "@/lib/agenda/fuso";

type Resource = { id: string; name: string; capacity: number; is_active: boolean; revision: number };
type Calendar = { id: string; name: string; account_email: string; user_id: string; available: boolean; can_read: boolean; can_write: boolean };
type Block = { id: string; scope_kind: string; event_type_id: string | null; owner_user_id: string | null; resource_id: string | null; starts_at: string; ends_at: string; reason: string; revision: number };
type Data = { service: DadosDoServico; resources: Resource[]; calendars: Calendar[]; blocks: Block[]; preview: { availability: DisponibilidadeDoServico[] } | null };
const field = "rounded-md border border-border bg-surface-elevated p-2 text-sm w-full";
const hhmm = (m: number) => `${Math.floor(m / 60).toString().padStart(2, "0")}:${(m % 60).toString().padStart(2, "0")}`;
const minute = (s: string) => { const [h = Number.NaN, m = Number.NaN] = s.split(":").map(Number); return h * 60 + m; };
const NEW_ROW: HorarioDoServico = { weekday: 1, on_date: null, timing_kind: "fixed", start_minute: 840, end_minute: null, duration_minutes: null, capacity_rule: "inherit", capacity_limit: null };

/** Formulário real: salva no mesmo núcleo que serve ao operador e à IA. */
export function ConfiguracaoDoServico({ typeId, name, pessoas, onClose, onEditType }: {
  typeId: string; name: string; pessoas: Array<{ id: string; nome: string }>; onClose: () => void; onEditType?: () => void;
}) {
  const t = useT(); const locale = useTagDeIdioma();
  const days = [t("Domingo"), t("Segunda-feira"), t("Terça-feira"), t("Quarta-feira"), t("Quinta-feira"), t("Sexta-feira"), t("Sábado")];
  const router = useRouter();
  const [data, setData] = React.useState<Data | null>(null);
  const panelId = React.useId();
  const [tab, setTab] = React.useState("service");
  const tabs = [{ id: "service", label: t("Serviço") }, { id: "hours", label: t("Horários") }, { id: "google", label: t("Google") }, { id: "blocks", label: t("Bloqueios") }];
  function revealField(target: HTMLElement) {
    const panel = target.closest<HTMLElement>("[data-service-panel]");
    if (panel) setTab(panel.dataset.servicePanel!);
    let parent = target.parentElement;
    while (parent) { if (parent instanceof HTMLDetailsElement) parent.open = true; parent = parent.parentElement; }
    requestAnimationFrame(() => requestAnimationFrame(() => target.focus()));
  }
  const loadGeneration = React.useRef(0);
  const [draft, setDraft] = React.useState<Config | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [loadError, setLoadError] = React.useState(false);
  const [preview, setPreview] = React.useState<DisponibilidadeDoServico[] | null>(null);
  const [day, setDay] = React.useState(() => new Date().toISOString().slice(0, 10));
  const [blockScope, setBlockScope] = React.useState("service");
  const [blockTarget, setBlockTarget] = React.useState("");
  const [blockPublication, setBlockPublication] = React.useState(false);
  const [blockKey, setBlockKey] = React.useState(() => randomId());
  const [blockImpact, setBlockImpact] = React.useState<{ signature: string; count: number } | null>(null);
  async function load(keepDraft = false) {
    const generation = ++loadGeneration.current;
    setLoadError(false);
    const result = (await apiClient.get<{ data: Data }>(`/api/v1/agenda/servicos?event_type_id=${typeId}`)).data;
    if (generation !== loadGeneration.current) return;
    setData(result);
    const s = result.service;
    if (!keepDraft) setDraft({ event_type_id: typeId, expected_revision: s.service_revision, service_enabled: s.service_enabled, is_active: s.is_active,
      requires_confirmation: s.requires_confirmation,
      booking_mode: s.booking_mode, service_capacity: s.service_capacity, service_timezone: s.service_timezone,
      destination_calendar_id: s.destination_calendar_id, service_publication_mode: s.service_publication_mode,
      professionals: s.professionals, resources: s.resources, calendar_sources: s.calendar_sources, schedule: s.schedule });
  }
  React.useEffect(() => { void Promise.resolve().then(() => load()).catch((e) => { setLoadError(true); showApiError(e); }); }, [typeId]); // eslint-disable-line react-hooks/exhaustive-deps
  async function execute(action: () => Promise<void>) {
    setBusy(true); setMessage("");
    try { await action(); } catch (e) { showApiError(e); } finally { setBusy(false); }
  }
  const change = (patch: Partial<Config>) => setDraft((d) => d ? { ...d, ...patch } : d);
  const rowChange = (i: number, patch: Partial<HorarioDoServico>) => change({ schedule: draft!.schedule.map((r, n) => n === i ? { ...r, ...patch } : r) });
  const toggle = (values: string[], value: string) => values.includes(value) ? values.filter((x) => x !== value) : [...values, value];
  const instanteLocal = (value: FormDataEntryValue | null) => {
    const parts = String(value).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
    if (!parts || !draft) throw new Error(t("Confira os campos."));
    return instanteDe({ ano: Number(parts[1]), mes: Number(parts[2]), dia: Number(parts[3]), hora: Number(parts[4]), minuto: Number(parts[5]) }, draft.service_timezone).toISOString();
  };
  if (!data || !draft) return <section aria-label={t("Serviço e horários")}><p role={loadError ? "alert" : "status"}>{loadError ? t("Não foi possível ler a configuração do serviço.") : t("Carregando…")}</p>{loadError && <Button onClick={() => void load().catch((e) => { setLoadError(true); showApiError(e); })}>{t("Tentar novamente")}</Button>}<Button onClick={onClose}>{t("Fechar")}</Button></section>;
  return <section className="space-y-4 rounded-lg border border-border bg-surface p-4" aria-label={t("Serviço e horários")} data-testid="service-configuration">
    <div className="flex flex-wrap items-start justify-between gap-2"><h2 className="min-w-0 break-words text-lg font-semibold">{t("Configurar")} {name}</h2><div className="flex flex-wrap gap-2">{onEditType && <Button type="button" variant="outline" onClick={onEditType}>{t("Nome e duração")}</Button>}<Button type="button" variant="ghost" onClick={onClose}>{t("Fechar")}</Button></div></div>
    <div role="tablist" aria-label={t("Configuração do serviço")} className="flex gap-1 overflow-x-auto border-b border-border pb-2">
      {tabs.map((item, i) => <Button key={item.id} type="button" role="tab" id={`${panelId}-tab-${item.id}`} aria-controls={`${panelId}-${item.id}`} aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1} variant={tab === item.id ? "default" : "ghost"} className="min-h-11 shrink-0" onClick={() => setTab(item.id)} onKeyDown={(e) => {
        const next = e.key === "ArrowRight" ? (i + 1) % tabs.length : e.key === "ArrowLeft" ? (i + tabs.length - 1) % tabs.length : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : null;
        const nextTab = next === null ? undefined : tabs[next];
        if (nextTab) { e.preventDefault(); setTab(nextTab.id); document.getElementById(`${panelId}-tab-${nextTab.id}`)?.focus(); }
      }}>{item.label}</Button>)}
    </div>
    <p className="text-sm text-text-muted">{t("Alterar a programação afeta novas reservas. As reservas existentes permanecem.")}</p>
    <form className="space-y-4" onInvalidCapture={(e) => { e.preventDefault(); const target = e.target as HTMLInputElement; setMessage(target.validationMessage); revealField(target); }} onSubmit={(e) => { e.preventDefault(); void execute(async () => {
      const parsed = configuracaoDoServicoSchema.safeParse(draft);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        setMessage(t(issue?.message ?? "Confira os campos."));
        const key = String(issue?.path[0] ?? "");
        const destination = key === "schedule" ? "hours" : ["destination_calendar_id", "service_publication_mode", "calendar_sources"].includes(key) ? "google" : "service";
        const panel = document.getElementById(`${panelId}-${destination}`);
        const rowIndex = key === "schedule" && typeof issue?.path[1] === "number" ? issue.path[1] : null;
        const area = rowIndex === null ? panel : panel?.querySelector(`[data-schedule-row="${rowIndex}"]`);
        const fieldKey = key === "schedule" ? String(issue?.path[2] ?? "") : key;
        const field = area?.querySelector<HTMLElement>(`[data-config-field="${fieldKey}"]`) ?? area?.querySelector<HTMLElement>("input, select, button");
        if (field) revealField(field); else setTab(destination);
        return;
      }
      const result = await apiClient.post<{ data: { future_reservations: number } }>("/api/v1/agenda/servicos", { action: "configure", config: parsed.data });
      await load(); setPreview(null); router.refresh(); setMessage(`${t("Configuração salva. Reservas futuras preservadas:")} ${result.data.future_reservations}`);
    }); }}>
      <fieldset disabled={busy} className="min-w-0 space-y-4 border-0 p-0">
      <div role="tabpanel" id={`${panelId}-service`} aria-labelledby={`${panelId}-tab-service`} data-service-panel="service" hidden={tab !== "service"} className="space-y-4">
      <label className="flex items-center gap-2"><input type="checkbox" checked={draft.service_enabled} onChange={(e) => change({ service_enabled: e.target.checked })}/>{t("Usar programação de serviço")}</label>
      {draft.service_enabled && <label className="flex items-center gap-2"><input type="checkbox" checked={draft.is_active !== false} onChange={(e) => change({ is_active: e.target.checked })}/>{t("Ativar reservas deste serviço")}</label>}
      {draft.service_enabled && draft.is_active === false && <p role="status">{t("Rascunho: novas reservas estão desativadas.")}</p>}
      <label className="flex items-center gap-2"><input type="checkbox" checked={!!draft.requires_confirmation} onChange={(e) => change({ requires_confirmation: e.target.checked })}/>{t("Exigir confirmação humana para este serviço")}</label>
      <p className="text-sm text-text-muted">{t("A reserva ocupa a vaga enquanto aguarda confirmação. Esta opção não envia mensagens.")}</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block space-y-1">{t("Como reservar")}<select aria-label={t("Como reservar")} className={field} data-config-field="booking_mode" value={draft.booking_mode} onChange={(e) => change({ booking_mode: e.target.value as Config["booking_mode"], schedule: e.target.value === "individual" ? draft.schedule.map((r) => ({ ...r, capacity_rule: "inherit", capacity_limit: null })) : draft.schedule })}>
          <option value="individual">{t("Individual por profissional")}</option><option value="collective_limited">{t("Coletivo com capacidade")}</option><option value="collective_unlimited">{t("Coletivo sem limite automático")}</option>
        </select></label>
        {draft.booking_mode === "collective_limited" && <label className="block space-y-1">{t("Capacidade padrão")}<input className={field} type="number" min={1} max={100000} data-config-field="service_capacity" value={draft.service_capacity ?? ""} onChange={(e) => change({ service_capacity: Number(e.target.value) || null })}/></label>}
      </div>
      <details className="rounded-md border border-border p-3"><summary className="cursor-pointer font-medium">{t("Opções adicionais")} · {draft.professionals.length} {t("profissionais")} · {draft.resources.length} {t("recursos")}</summary><div className="mt-3 space-y-4">
        <label className="block space-y-1">{t("Fuso do serviço")}<input className={field} data-config-field="service_timezone" value={draft.service_timezone} onChange={(e) => change({ service_timezone: e.target.value })}/></label>
      <fieldset className="space-y-2"><legend className="font-medium">{t("Profissionais habilitados")}</legend><p className="text-sm text-text-muted">{t("Quando escolhidos, a reserva também respeita a jornada e os conflitos do profissional.")}</p><div className="flex flex-wrap gap-4">{pessoas.map((p) => <label className="flex gap-2" key={p.id}><input type="checkbox" checked={draft.professionals.includes(p.id)} onChange={() => change({ professionals: toggle(draft.professionals, p.id) })}/>{p.nome}</label>)}</div></fieldset>
      <fieldset className="space-y-2"><legend className="font-medium">{t("Recursos opcionais")}</legend>{data.resources.filter((r) => r.is_active || draft.resources.some((s) => s.resource_id === r.id)).map((r) => {
        const selected = draft.resources.find((s) => s.resource_id === r.id);
        return <div className="flex items-center gap-3" key={r.id}><label className="flex gap-2"><input type="checkbox" checked={!!selected} onChange={() => change({ resources: selected ? draft.resources.filter((s) => s.resource_id !== r.id) : [...draft.resources, { resource_id: r.id, units: 1 }] })}/>{r.name}</label>{selected && <label className="block space-y-1">{t("Unidades necessárias")}<input className={field} type="number" min={1} max={r.capacity} value={selected.units} onChange={(e) => change({ resources: draft.resources.map((s) => s.resource_id === r.id ? { ...s, units: Number(e.target.value) } : s) })}/></label>}</div>;
      })}</fieldset>
      </div></details>
      </div>
      <div role="tabpanel" id={`${panelId}-hours`} aria-labelledby={`${panelId}-tab-hours`} data-service-panel="hours" hidden={tab !== "hours"} className="space-y-4">
      <fieldset className="space-y-3"><legend className="font-medium">{t("Programação")}</legend>
        {draft.schedule.map((row, i) => <details className="rounded-md border border-border p-3" key={row.id ?? `new-${i}`} data-schedule-row={i} open={row.id ? undefined : true}>
          <summary className="cursor-pointer break-words font-medium">{row.on_date ?? days[row.weekday ?? 1]} · {hhmm(row.start_minute)}{row.timing_kind === "window" && `–${hhmm(row.end_minute ?? 1080)}`} · {row.duration_minutes ?? data.service.duration_minutes} {t("min")} · {draft.booking_mode === "individual" ? t("Individual por profissional") : row.capacity_rule === "unlimited" || (row.capacity_rule === "inherit" && draft.booking_mode === "collective_unlimited") ? t("Sem limite automático") : row.capacity_rule === "limited" ? row.capacity_limit : draft.service_capacity}</summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <label className="block space-y-1">{t("Quando")}<select aria-label={t("Quando")} className={field} data-config-field="on_date" value={row.on_date ? "date" : "weekly"} onChange={(e) => rowChange(i, e.target.value === "date" ? { on_date: day, weekday: null } : { on_date: null, weekday: 1 })}><option value="weekly">{t("Toda semana")}</option><option value="date">{t("Somente nesta data")}</option></select></label>
          {row.on_date ? <label className="block space-y-1">{t("Data")}<input className={field} type="date" data-config-field="on_date" value={row.on_date} onChange={(e) => rowChange(i, { on_date: e.target.value })}/></label>
            : <label className="block space-y-1">{t("Dia da semana")}<select aria-label={t("Dia da semana")} className={field} value={row.weekday ?? 1} onChange={(e) => rowChange(i, { weekday: Number(e.target.value) })}>{days.map((label, n) => <option key={label} value={n}>{label}</option>)}</select></label>}
          <label className="block space-y-1">{t("Horário ou faixa")}<select aria-label={t("Horário ou faixa")} className={field} value={row.timing_kind} onChange={(e) => rowChange(i, { timing_kind: e.target.value as HorarioDoServico["timing_kind"], end_minute: e.target.value === "window" ? Math.min(1440, row.start_minute + 120) : null })}><option value="fixed">{t("Horário fixo")}</option><option value="window">{t("Faixa de atendimento")}</option></select></label>
          <label className="block space-y-1">{t("Início")}<input className={field} type="time" value={hhmm(row.start_minute)} onChange={(e) => rowChange(i, { start_minute: minute(e.target.value) })}/></label>
          {row.timing_kind === "window" && <label className="block space-y-1">{t("Fim da faixa")}<input className={field} type="time" value={hhmm(row.end_minute ?? 1080)} onChange={(e) => rowChange(i, { end_minute: minute(e.target.value) })}/></label>}
          <label className="block space-y-1">{t("Duração diferente neste horário (min)")}<input className={field} type="number" min={5} max={1440} data-config-field="duration_minutes" value={row.duration_minutes ?? ""} placeholder={String(data.service.duration_minutes)} onChange={(e) => rowChange(i, { duration_minutes: Number(e.target.value) || null })}/></label>
          {draft.booking_mode !== "individual" && <><label className="block space-y-1">{t("Capacidade deste horário")}<select aria-label={t("Capacidade deste horário")} className={field} data-config-field="capacity_rule" value={row.capacity_rule} onChange={(e) => rowChange(i, { capacity_rule: e.target.value as HorarioDoServico["capacity_rule"], capacity_limit: e.target.value === "limited" ? 1 : null })}><option value="inherit">{t("Usar a regra do serviço")}</option><option value="limited">{t("Definir limite para este horário")}</option><option value="unlimited">{t("Sem limite automático neste horário")}</option></select></label>
            {row.capacity_rule === "limited" && <label className="block space-y-1">{t("Limite deste horário")}<input className={field} type="number" min={1} data-config-field="capacity_limit" value={row.capacity_limit ?? ""} onChange={(e) => rowChange(i, { capacity_limit: Number(e.target.value) || null })}/></label>}</>}
          <div className="flex gap-2"><Button type="button" variant="outline" onClick={() => change({ schedule: [...draft.schedule, { ...row, id: undefined, weekday: row.weekday == null ? null : (row.weekday + 1) % 7 }] })}>{t("Copiar horário")}</Button><Button type="button" variant="ghost" onClick={() => change({ schedule: draft.schedule.filter((_, n) => n !== i) })}>{t("Remover")}</Button></div>
        </div></details>)}
        <Button type="button" variant="outline" onClick={() => change({ schedule: [...draft.schedule, { ...NEW_ROW }] })}>{t("Adicionar horário")}</Button>
      </fieldset>
      </div>
      <div role="tabpanel" id={`${panelId}-google`} aria-labelledby={`${panelId}-tab-google`} data-service-panel="google" hidden={tab !== "google"} className="space-y-4">
      <fieldset className="space-y-2"><legend className="font-medium">{t("Publicação Google")}</legend><select aria-label={t("Destino de publicação")} className={field} data-config-field="service_publication_mode" value={draft.service_publication_mode} onChange={(e) => change({ service_publication_mode: e.target.value as Config["service_publication_mode"], destination_calendar_id: null })}><option value="none">{t("Somente no CRM")}</option><option value="service">{t("Calendário compartilhado do serviço")}</option><option value="professional">{t("Calendário do profissional escolhido")}</option></select>
        {draft.service_publication_mode === "service" && <label className="block space-y-1">{t("Calendário de destino")}<select aria-label={t("Calendário de destino")} className={field} data-config-field="destination_calendar_id" value={draft.destination_calendar_id ?? ""} onChange={(e) => change({ destination_calendar_id: e.target.value || null })}><option value="">{t("Escolha uma agenda")}</option>{draft.destination_calendar_id && !data.calendars.some((c) => c.id === draft.destination_calendar_id && c.can_write && c.available) && <option data-config-field="destination_calendar_id" value={draft.destination_calendar_id}>{data.calendars.find((c) => c.id === draft.destination_calendar_id)?.name ?? t("Calendário de destino")} · {t("Não disponível")}</option>}{data.calendars.filter((c) => c.can_write && c.available).map((c) => <option key={c.id} value={c.id}>{c.name} · {c.account_email}</option>)}</select></label>}
        <p className="text-sm text-text-muted">{t("As reservas já publicadas mantêm seu destino. Reserva CRM não comprova publicação Google.")}</p>
        <p>{t("Agendas que bloqueiam este serviço")}</p><p className="text-sm text-text-muted">{t("A capacidade é por serviço. Compartilhar um calendário não cria um limite global.")}</p>{data.calendars.filter((c) => draft.calendar_sources.includes(c.id)).map((c) => <label className="flex items-start gap-2" key={c.id}><input type="checkbox" checked onChange={() => change({ calendar_sources: toggle(draft.calendar_sources, c.id) })}/><span className="min-w-0 break-words">{c.name}<small className="block text-text-muted">{c.account_email}{(!c.can_read || !c.available) && ` · ${t("Não disponível")}`}</small></span></label>)}
        <details><summary className="cursor-pointer py-2">{t("Outras agendas disponíveis")}</summary><div className="space-y-3 py-2">{data.calendars.filter((c) => c.can_read && c.available && !draft.calendar_sources.includes(c.id)).map((c) => <label className="flex items-start gap-2" key={c.id}><input type="checkbox" checked={false} onChange={() => change({ calendar_sources: toggle(draft.calendar_sources, c.id) })}/><span className="min-w-0 break-words">{c.name}<small className="block text-text-muted">{c.account_email}</small></span></label>)}</div></details>
      </fieldset>
      </div>
      <Button type="submit" hidden={tab === "blocks"} disabled={busy}>{busy ? t("Salvando…") : t("Salvar programação")}</Button>
      </fieldset>
    </form>
    {message && <p role="status" className="break-words rounded-md bg-surface-elevated p-3">{message}</p>}
    <div data-service-panel="hours" hidden={tab !== "hours"} className="space-y-2 border-t pt-3"><h3 className="font-medium">{t("Conferir horários salvos")}</h3><label className="block space-y-1">{t("Data")}<input className={field} type="date" value={day} onChange={(e) => setDay(e.target.value)}/></label><Button disabled={busy} variant="outline" onClick={() => void execute(async () => {
      await apiClient.post("/api/v1/agenda/servicos", { action: "refresh", event_type_id: typeId });
      const start = new Date(`${day}T00:00:00Z`), de = new Date(start.getTime() - 14 * 3600000), ate = new Date(start.getTime() + 38 * 3600000);
      const result = (await apiClient.get<{ data: Data }>(`/api/v1/agenda/servicos?event_type_id=${typeId}&de=${encodeURIComponent(de.toISOString())}&ate=${encodeURIComponent(ate.toISOString())}`)).data;
      setPreview((result.preview?.availability ?? []).filter((s) => diaLocalISO(new Date(s.starts_at), draft.service_timezone) === day));
    })}>{t("Atualizar fontes e conferir")}</Button>
      {preview && <ul aria-label={t("Prévia dos horários")}>{preview.map((s) => <li key={s.starts_at} className="border-b py-2">{new Date(s.starts_at).toLocaleString(locale, { timeZone: draft.service_timezone })} · {s.available ? t("Disponível") : t(MOTIVOS_DO_SERVICO[s.reason ?? ""] ?? "Não disponível")}{s.available && ` · ${s.duration_minutes} ${t("min")} · ${s.booking_mode === "individual" ? t("Individual por profissional") : s.capacity_limit == null ? t("Sem limite automático") : `${s.remaining_capacity} ${t("vagas restantes")}`}`}</li>)}{preview.length === 0 && <li>{t("Nenhum horário programado neste período.")}</li>}</ul>}
    </div>
    <div role="tabpanel" id={`${panelId}-blocks`} aria-labelledby={`${panelId}-tab-blocks`} data-service-panel="blocks" hidden={tab !== "blocks"} className="space-y-4">
    <form className="space-y-2 border-t pt-3" onChange={() => setBlockImpact(null)} onSubmit={(e) => { e.preventDefault(); const values = new FormData(e.currentTarget); void execute(async () => {
      const input = { operation_key: blockKey, scope_kind: blockScope,
        ...(blockScope === "service" ? { event_type_id: typeId } : blockScope === "professional" ? { owner_user_id: blockTarget } : { resource_id: blockTarget }),
        starts_at: instanteLocal(values.get("block_start")), ends_at: instanteLocal(values.get("block_end")), reason: values.get("block_reason"), publish_google: blockPublication && blockScope === "service" };
      const signature = JSON.stringify(input);
      if (blockImpact?.signature !== signature) {
        const preview = await apiClient.post<{ data: { existing_reservations_preserved: number } }>("/api/v1/agenda/servicos", { action: "block_preview", input });
        setBlockImpact({ signature, count: preview.data.existing_reservations_preserved }); return;
      }
      const result = await apiClient.post<{ data: { existing_reservations_preserved: number } }>("/api/v1/agenda/servicos", { action: "block", input });
      setBlockKey(randomId()); setBlockImpact(null); await load(true); setMessage(`${t("Bloqueio salvo. Reservas existentes preservadas:")} ${result.data.existing_reservations_preserved}`);
    }); }}><h3 className="font-medium">{t("Bloquear novas reservas")}</h3><p className="text-sm">{t("O bloqueio impede novas reservas no alcance escolhido. Não cancela reservas nem envia mensagens.")}</p>
      <label className="block space-y-1">{t("Alcance do bloqueio")}<select aria-label={t("Alcance do bloqueio")} className={field} value={blockScope} onChange={(e) => { setBlockScope(e.target.value); setBlockTarget(""); setBlockPublication(false); }}><option value="service">{t("Somente este serviço")}</option><option value="professional">{t("Profissional em todos os serviços")}</option><option value="resource">{t("Recurso em todos os serviços")}</option></select></label>
      {blockScope !== "service" && <select aria-label={t("Alvo do bloqueio")} className={field} required value={blockTarget} onChange={(e) => setBlockTarget(e.target.value)}><option value="">{t("Escolha")}</option>{(blockScope === "professional" ? pessoas.map((p) => ({ id: p.id, name: p.nome })) : data.resources).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>}
      <div className="grid gap-2 sm:grid-cols-2"><label className="block space-y-1">{t("Começa em")}<input name="block_start" className={field} required type="datetime-local"/></label><label className="block space-y-1">{t("Termina em")}<input name="block_end" className={field} required type="datetime-local"/></label></div>
      <p className="text-xs text-text-muted">{t("Fuso do serviço")}: {draft.service_timezone}</p>
      <label className="block space-y-1">{t("Motivo")}<input name="block_reason" className={field} required maxLength={300}/></label>
      {blockScope === "service" && draft.service_publication_mode === "service" && <label className="flex gap-2"><input type="checkbox" checked={blockPublication} onChange={(e) => setBlockPublication(e.target.checked)}/>{t("Publicar também no calendário deste serviço")}</label>}
      {blockImpact && <p role="status">{t("Reservas existentes neste alcance:")} {blockImpact.count}. {t("Serão preservadas. A contagem é conferida novamente ao aplicar.")}</p>}
      <Button type="submit" disabled={busy}>{t(blockImpact ? "Aplicar bloqueio no alcance acima" : "Conferir alcance do bloqueio")}</Button>
    </form>
    <ul aria-label={t("Bloqueios ativos")}>{data.blocks.filter((b) => b.scope_kind !== "service" || b.event_type_id === typeId).map((b) => <li className="flex flex-wrap items-center justify-between gap-2 border-b py-2" key={b.id}><span>{t(b.scope_kind === "service" ? "Somente este serviço" : b.scope_kind === "professional" ? "Profissional em todos os serviços" : "Recurso em todos os serviços")} · {b.scope_kind === "professional" ? pessoas.find((p) => p.id === b.owner_user_id)?.nome : b.scope_kind === "resource" ? data.resources.find((r) => r.id === b.resource_id)?.name : name} · {new Date(b.starts_at).toLocaleString(locale, { timeZone: draft.service_timezone })} · {b.reason}</span><Button variant="outline" disabled={busy} onClick={() => void execute(async () => { await apiClient.post("/api/v1/agenda/servicos", { action: "unblock", input: { archive_id: b.id, expected_revision: b.revision } }); await load(true); })}>{t("Retirar bloqueio")}</Button></li>)}</ul>
    <details className="rounded-md border border-border p-3"><summary className="cursor-pointer font-medium">{t("Gerenciar recursos")}</summary><div className="mt-3 space-y-3">
    <form className="space-y-2 border-t pt-3" onSubmit={(e) => { e.preventDefault(); const values = new FormData(e.currentTarget); void execute(async () => {
      await apiClient.post("/api/v1/agenda/servicos", { action: "resource", input: { name: values.get("resource_name"), capacity: Number(values.get("resource_capacity")) } }); await load(true);
    }); }}><h3 className="font-medium">{t("Cadastrar recurso")}</h3><div className="grid gap-2 sm:grid-cols-3"><label className="block space-y-1">{t("Nome do recurso")}<input className={field} name="resource_name" required minLength={2}/></label><label className="block space-y-1">{t("Unidades disponíveis")}<input className={field} type="number" name="resource_capacity" required min={1} defaultValue={1}/></label><Button type="submit" disabled={busy}>{t("Adicionar recurso")}</Button></div></form>
    {data.resources.map((r) => <form key={`${r.id}:${r.revision}`} className="grid gap-2 rounded-md border p-3 sm:grid-cols-3" onSubmit={(e) => { e.preventDefault(); const values = new FormData(e.currentTarget); void execute(async () => {
      await apiClient.post("/api/v1/agenda/servicos", { action: "resource", input: { id: r.id, expected_revision: r.revision, name: values.get("name"), capacity: Number(values.get("capacity")), is_active: values.get("active") === "on" } }); await load(true);
    }); }}><label className="block space-y-1">{t("Nome do recurso")}<input className={field} name="name" defaultValue={r.name} minLength={2} required/></label><label className="block space-y-1">{t("Unidades disponíveis")}<input className={field} type="number" min={1} name="capacity" defaultValue={r.capacity} required/></label><div className="flex items-center gap-2"><label className="flex gap-2"><input type="checkbox" name="active" defaultChecked={r.is_active}/>{t("Ativo")}</label><Button type="submit" variant="outline" disabled={busy}>{t("Salvar recurso")}</Button></div></form>)}
    </div></details>
    </div>
  </section>;
}
