"use client";
import * as React from "react";
import { randomId } from "@/lib/random-id";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { apiClient } from "@/lib/api/client";
import { diaLocalISO } from "@/lib/agenda/fuso";
import { MOTIVOS_DO_SERVICO } from "@/lib/agenda/servicos/motivos";
import type { DisponibilidadeDoServico } from "@/lib/agenda/servicos/consulta";

type Service = { id: string; name: string; service_enabled?: boolean; requires_confirmation: boolean; booking_mode?: string };
type Receipt = { id: string; status: string; starts_at: string; ends_at: string; time_zone: string; participant_name: string | null; google_publication: string; human_confirmation: string; deduplicated?: boolean };
const PUBLICATION: Record<string, string> = { not_configured: "Somente no CRM", pending: "Publicação pendente", synced: "Publicado no Google", failed: "Falha de publicação", conflict: "Conflito com o Google", removed: "Remoção confirmada no Google" };
// 16px abaixo do md: o Safari do iPhone amplia a página ao focar campo menor.
const field = "rounded-md border border-border bg-surface-elevated p-2 text-base md:text-sm w-full";

/** Reserva pelo escritor normal. Não manda mensagem nem publica um agente. */
export function ReservarServicoNaConversa({ contactId, conversationId, contactName }: { contactId: string; conversationId: string; contactName: string }) {
  const t = useT(); const locale = useTagDeIdioma();
  const qc = useQueryClient();
  const peopleHint = React.useId();
  const [open, setOpen] = React.useState(false);
  const [services, setServices] = React.useState<Service[]>([]);
  const [typeId, setTypeId] = React.useState("");
  const [day, setDay] = React.useState(() => new Date().toISOString().slice(0, 10));
  const [people, setPeople] = React.useState("");
  const [availability, setAvailability] = React.useState<DisponibilidadeDoServico[] | null>(null);
  const [selected, setSelected] = React.useState<DisponibilidadeDoServico | null>(null);
  const [zone, setZone] = React.useState("America/Sao_Paulo");
  const [busy, setBusy] = React.useState(false);
  const [receipts, setReceipts] = React.useState<Receipt[] | null>(null);
  const command = React.useRef<{ body: string; key: string } | null>(null);
  async function execute(action: () => Promise<void>) { setBusy(true); try { await action(); } catch (e) { showApiError(e); } finally { setBusy(false); } }
  async function consult() {
    setSelected(null); setReceipts(null);
    await apiClient.post("/api/v1/agenda/servicos/atualizar", { event_type_id: typeId });
    const start = new Date(`${day}T00:00:00Z`);
    const de = new Date(start.getTime() - 14 * 3600000), ate = new Date(start.getTime() + 38 * 3600000);
    const result = (await apiClient.get<{ data: { fuso_da_regra: string; servico?: { availability: DisponibilidadeDoServico[] } } }>(`/api/v1/agenda/horarios-livres?event_type_id=${typeId}&de=${encodeURIComponent(de.toISOString())}&ate=${encodeURIComponent(ate.toISOString())}`)).data;
    setZone(result.fuso_da_regra);
    setAvailability((result.servico?.availability ?? []).filter((row) => diaLocalISO(new Date(row.starts_at), result.fuso_da_regra) === day));
  }
  return <><Button size="sm" variant="outline" onClick={() => { setOpen(true); void execute(async () => {
    const rows = (await apiClient.get<{ data: Service[] }>("/api/v1/agenda/tipos")).data;
    const valid = rows.filter((r) => r.service_enabled); setServices(valid); if (!typeId && valid[0]) setTypeId(valid[0].id);
  }); }}>{t("Reservar serviço")}</Button>
    <Sheet open={open} onOpenChange={setOpen}><SheetContent className="overflow-y-auto sm:max-w-lg"><SheetHeader><SheetTitle className="break-words">{services.find((s) => s.id === typeId)?.name ? <>{t("Agendar")} {services.find((s) => s.id === typeId)?.name}</> : t("Reservar serviço")}</SheetTitle></SheetHeader>
      <div className="space-y-4 py-4"><p>{t("Contato responsável:")} {contactName}</p><p className="text-sm text-text-muted">{t("Consultar não reserva. Reservar não envia mensagem nem comprova publicação Google.")}</p>
        {services.length === 0 ? <p>{t("Nenhum serviço com programação ativa. Configure em Configurações da Agenda.")}</p> : <>
          <label className="block space-y-1">{t("Serviço")}<select aria-label={t("Serviço")} className={field} value={typeId} onChange={(e) => { setTypeId(e.target.value); setAvailability(null); setSelected(null); setReceipts(null); }}>{services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          <label className="block space-y-1">{t("Data")}<input className={field} type="date" value={day} onChange={(e) => { setDay(e.target.value); setAvailability(null); setSelected(null); setReceipts(null); }}/></label>
          <Button variant="outline" disabled={busy} onClick={() => void execute(consult)}>{t("Consultar horários")}</Button>
          {availability && <div role="group" aria-label={t("Horários do serviço")} className="space-y-2">{availability.map((s) => <Button key={s.starts_at} className="h-auto w-full justify-start whitespace-normal py-3" variant={selected?.starts_at === s.starts_at ? "default" : "outline"} disabled={!s.available || busy} onClick={() => setSelected(s)}>
            {new Date(s.starts_at).toLocaleTimeString(locale, { timeZone: zone, hour: "2-digit", minute: "2-digit" })} · {s.available ? s.booking_mode === "individual" ? t("Individual por profissional") : s.capacity_limit == null ? t("Sem limite automático") : `${s.remaining_capacity} ${t("vagas restantes")}` : t(MOTIVOS_DO_SERVICO[s.reason ?? ""] ?? "Não disponível")}
          </Button>)}{availability.length === 0 && <p>{t("Nenhum horário programado neste período.")}</p>}</div>}
          <label className="block space-y-1">{t("Pessoas atendidas (uma por linha)")}<textarea aria-label={t("Pessoas atendidas (uma por linha)")} aria-describedby={peopleHint} className={field} value={people} onChange={(e) => setPeople(e.target.value)} placeholder={contactName}/><span id={peopleHint} className="block text-xs text-text-muted">{t("Deixe vazio para reservar para o próprio contato. Informe somente pessoas pedidas por ele.")}</span></label>
          <Button disabled={busy || !selected} onClick={() => void execute(async () => {
            const names = people.split("\n").map((p) => p.trim()).filter(Boolean);
            const input = { event_type_id: typeId, starts_at: selected!.starts_at, contact_id: contactId, conversation_id: conversationId,
              expected_service_revision: selected!.service_revision, ...(names.length ? { participants: names } : {}) };
            const signature = JSON.stringify(input);
            if (command.current?.body !== signature) command.current = { body: signature, key: randomId() };
            const result = (await apiClient.post<{ data: Receipt & { appointments?: Receipt[] } }>("/api/v1/agenda/agendamentos", input, { idempotencyKey: command.current.key })).data;
            setReceipts(result.appointments ?? [result]); setSelected(null); void qc.invalidateQueries({ queryKey: ["agenda"] });
          })}>{busy ? t("Reservando…") : t("Reservar o horário escolhido")}</Button>
        </>}
        {receipts?.map((r) => <section key={r.id} className="space-y-2 rounded-md border p-3" aria-label={t("Recibo da reserva")}>
          <p className="font-semibold">{r.participant_name ?? contactName} · {new Date(r.starts_at).toLocaleString(locale, { timeZone: r.time_zone })}</p>
          <dl className="grid grid-cols-2 gap-2 text-sm"><dt>{t("Reserva CRM")}</dt><dd>{t(r.status === "pending" ? "Reservado, aguardando confirmação" : r.status === "confirmed" ? "Confirmada" : r.status === "cancelled" ? "Cancelada" : "Encerrada")}</dd>
            <dt>{t("Confirmação humana")}</dt><dd>{t(r.human_confirmation === "pending" ? "Pendente" : r.human_confirmation === "not_required" ? "Não exigida para este serviço" : r.human_confirmation === "confirmed" ? "Confirmada pela equipe" : r.human_confirmation === "not_applicable" ? "Não se aplica à reserva encerrada" : "Confira o registro da equipe")}</dd>
            <dt>{t("Comunicação")}</dt><dd>{t("Não comprovada pela reserva")}</dd><dt>{t("Publicação Google")}</dt><dd>{t(PUBLICATION[r.google_publication] ?? "Publicação pendente")}</dd></dl>
          {r.deduplicated && <p className="text-xs">{t("Reserva existente recuperada, sem criar outra.")}</p>}
        </section>)}
      </div>
    </SheetContent></Sheet></>;
}
