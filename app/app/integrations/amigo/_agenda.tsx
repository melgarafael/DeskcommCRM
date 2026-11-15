"use client";
import { useT } from "@/hooks/i18n/useT";
import { useCallback, useState, useLayoutEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { amigoRequest, errorText, read, pinAmigoConnection } from "./_api";
import { useAmigoMutation, useLoad } from "./_hooks";
import { AmigoBooking } from "./_booking";
import { PatientPicker } from "./_patient-picker";
import { AmigoMutationBoundary } from "./_mutation-boundary";
import {
  Field,
  MutationNotice,
  Notice,
  Panel,
  Pick,
  options,
  civilTime,
  clinicDate,
  shifts,
} from "./_ui";
import type { AmigoSafeConfig, Attendance, DoctorSlot, Named, Patient } from "./_types";

const statuses: Record<string, string> = {
  scheduled: "Agendada",
  confirmed: "Confirmada",
  arrived: "Chegou",
  in_attendance: "Em atendimento",
  done: "Concluída",
  canceled: "Cancelada",
  missed: "Faltou",
};
function attendanceStatus(item: Attendance): string {
  return (
    item.status ??
    (item.canceled
      ? "canceled"
      : item.done
        ? "done"
        : item.missed
          ? "missed"
          : item.in_attendance
            ? "in_attendance"
            : item.arrived
              ? "arrived"
              : item.confirmed_at
                ? "confirmed"
                : "scheduled")
  );
}
export function AttendanceList({
  items,
  timezone,
  contactId,
  onChanged,
}: {
  items: Attendance[];
  timezone: string;
  contactId?: string;
  onChanged?: () => void;
}) {
  const t = useT();
  if (!items.length)
    return <p className="text-sm text-muted-foreground">{t("Nenhuma consulta para estes filtros.")}</p>;
  return (
    <div className="space-y-3">
      {items.map((item) => (
        <AttendanceRow
          key={item.id}
          item={item}
          timezone={timezone}
          contactId={contactId}
          onChanged={onChanged}
        />
      ))}
    </div>
  );
}
function AttendanceRow({
  item,
  timezone,
  contactId,
  onChanged,
}: {
  item: Attendance;
  timezone: string;
  contactId?: string;
  onChanged?: () => void;
}) {
  const t = useT();
  const mutation = useAmigoMutation();
  const [cancel, setCancel] = useState(false);
  const [reschedule, setReschedule] = useState(false);
  const patientId = item.patient_id ?? item.patient?.id;
  const arrivalWindow =
    item.arrival_start_time && item.arrival_end_time
      ? `${item.arrival_start_time}–${item.arrival_end_time}`
      : item.timegrids?.map((grid) => `${grid.start}–${grid.end}`).join(", ");
  const status = attendanceStatus(item);
  const frozen =
    mutation.pending ||
    mutation.blocked ||
    ["canceled", "done", "missed", "in_attendance"].includes(status);
  const act = async (
    operation: "attendance_status" | "attendance_cancel" | "attendance_reschedule",
    input: Record<string, unknown>,
  ) => {
    if (await mutation.run(operation, input, contactId)) {
      setCancel(false);
      setReschedule(false);
      onChanged?.();
    }
  };
  return (
    <article className="min-w-0 space-y-3 rounded-md border p-4">
      <div className="flex flex-wrap justify-between gap-3">
        <div>
          <h3 className="font-medium">
            {item.patient?.name ?? item.name ?? t("Paciente não informado")}
          </h3>
          <p className="text-sm text-muted-foreground">
            {item.agenda_event?.name ?? item.event?.name ?? t("Atendimento")} ·{" "}
            {item.user?.name ?? t("Médico não informado")} ·{" "}
            {item.place?.name ?? t("Unidade não informada")}
          </p>
          <p className="mt-1 text-sm">
            {item.start_date
              ? civilTime(item.start_date, timezone)
              : (item.startDateFormatted ?? t("Data não informada"))}
            {(item.is_arrival_order ?? item.user?.config_arrival_order) &&
              ` · ${shifts[item.shift ?? ""] ?? t("Turno")} · ${t("ordem de chegada, sem promessa de hora exata")}`}
            {(item.is_arrival_order ?? item.user?.config_arrival_order) &&
              arrivalWindow &&
              ` · ${arrivalWindow}`}
          </p>
        </div>
        <div className="text-sm">
          <p className="font-medium">
            {statuses[status] ? t(statuses[status]) : t("Estado não informado")}
          </p>
          <p className="text-xs text-muted-foreground">
            Amigo · {t("consulta")} {item.id}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={frozen || !patientId || status === "confirmed" || status === "arrived"}
          onClick={() =>
            void act("attendance_status", {
              attendance_id: item.id,
              patient_id: patientId,
              status: "confirmed",
            })
          }
        >
          {t("Confirmar")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={frozen || !patientId || status === "arrived"}
          onClick={() =>
            void act("attendance_status", {
              attendance_id: item.id,
              patient_id: patientId,
              status: "arrived",
            })
          }
        >
          {t("Registrar chegada")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={frozen}
          onClick={() => {
            setReschedule(!reschedule);
            setCancel(false);
          }}
        >
          {t("Remarcar")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={frozen}
          onClick={() => {
            setCancel(true);
            setReschedule(false);
          }}
        >
          {t("Cancelar consulta")}
        </Button>
      </div>
      {cancel && (
        <div className="flex flex-wrap items-center gap-3 rounded-md bg-muted/40 p-3 text-sm">
          <p>{t("Cancelar esta consulta no Amigo?")}</p>
          <Button
            variant="destructive"
            disabled={frozen}
            onClick={() => void act("attendance_cancel", { id: item.id })}
          >
            {t("Confirmar cancelamento")}
          </Button>
          <Button variant="ghost" onClick={() => setCancel(false)}>
            {t("Manter consulta")}
          </Button>
        </div>
      )}
      {reschedule && (
        <Reschedule
          item={item}
          timezone={timezone}
          disabled={frozen}
          onSave={(date) => void act("attendance_reschedule", { id: item.id, date })}
        />
      )}
      <MutationNotice mutation={mutation} />
    </article>
  );
}
function Reschedule({
  item,
  timezone,
  disabled,
  onSave,
}: {
  item: Attendance;
  timezone: string;
  disabled: boolean;
  onSave: (date: string) => void;
}) {
  const t = useT();
  const [day, setDay] = useState("");
  const [choice, setChoice] = useState("");
  const doctor = item.user_id ?? item.user?.id;
  const event = item.event_id ?? item.agenda_event?.id ?? item.event?.id;
  const place = item.place_id ?? item.place?.id;
  const loader = useCallback(
    () =>
      read<(string | DoctorSlot)[]>("doctor_dates", {
        id: doctor,
        event_id: event,
        ...(place ? { place_id: place } : {}),
        ...((item.patient_id ?? item.patient?.id)
          ? { patient_id: item.patient_id ?? item.patient?.id }
          : {}),
        ...(item.insurance_id ? { insurance_id: item.insurance_id } : {}),
        ...(day ? { date: day } : {}),
      }),
    [doctor, event, place, item.patient_id, item.patient?.id, item.insurance_id, day],
  );
  const result = useLoad(loader, !!doctor && !!event);
  const [days, setDays] = useState<string[]>([]);
  // A resposta sem data pode conter dias ou vagas. Preservar a lista ao buscar o dia.
  const returnedDays = !day
    ? [
        ...new Set(
          (result.data ?? []).map((value) =>
            typeof value === "string"
              ? `${value.slice(6)}-${value.slice(3, 5)}-${value.slice(0, 2)}`
              : civilTime(value.formatted_start_date ?? value.start_date, timezone).slice(0, 10),
          ),
        ),
      ]
    : days;
  const slots = (result.data ?? []).filter(
    (value): value is DoctorSlot =>
      typeof value !== "string" &&
      value.user_id === doctor &&
      (!value.place_id || value.place_id === place) &&
      civilTime(value.formatted_start_date ?? value.start_date, timezone).startsWith(day),
  );
  return (
    <fieldset disabled={disabled} className="space-y-3 rounded-md border p-4">
      <legend className="text-sm font-medium">{t("Escolha a nova vaga")}</legend>
      {!doctor || !event ? (
        <p className="text-sm">
          {t("Faltam o médico ou o tipo de atendimento. Confira esta consulta diretamente no Amigo.")}
        </p>
      ) : (
        <>
          <Pick
            label={t("Novo dia disponível")}
            value={day}
            options={returnedDays.map((value) => ({
              value,
              label: value.split("-").reverse().join("/"),
            }))}
            onChange={(e) => {
              setDays(returnedDays);
              setDay(e.target.value);
              setChoice("");
            }}
          />
          <Pick
            label={t("Nova vaga")}
            value={choice}
            disabled={!day || result.loading}
            options={slots.map((value) => ({
              value: value.id,
              label: value.is_arrival_order
                ? `${shifts[value.shift ?? ""] ?? t("Turno")} · ${t("ordem de chegada, sem hora exata")}`
                : civilTime(value.formatted_start_date ?? value.start_date, timezone).slice(11),
            }))}
            onChange={(e) => setChoice(e.target.value)}
          />
          <Button
            disabled={!choice || disabled || result.loading}
            onClick={() => {
              const slot = slots.find((value) => value.id === choice);
              if (slot) onSave(civilTime(slot.formatted_start_date ?? slot.start_date, timezone));
            }}
          >
            {t("Confirmar remarcação")}
          </Button>
          {result.data?.length === 0 && (
            <p className="text-sm">{t("Sem vagas. Confira outra data no Amigo.")}</p>
          )}
        </>
      )}
      <Notice loading={result.loading} error={result.error} />
    </fieldset>
  );
}

export function AmigoAgenda(props: {
  initialConfig: AmigoSafeConfig;
  canManage?: boolean;
  contactId?: string;
  onSync?: () => Promise<void>;
}) {
  return (
    <AmigoMutationBoundary>
      <AgendaContent {...props} />
    </AmigoMutationBoundary>
  );
}
function AgendaContent({
  initialConfig: config,
  canManage = true,
  contactId,
  onSync,
}: {
  initialConfig: AmigoSafeConfig;
  canManage?: boolean;
  contactId?: string;
  onSync?: () => Promise<void>;
}) {
  const t = useT();
  const [patient, setPatient] = useState<Patient | null>(null);
  const [start, setStart] = useState(clinicDate(config.timezone));
  const [end, setEnd] = useState(clinicDate(config.timezone, true));
  const [place, setPlace] = useState(String(config.default_place_id ?? ""));
  const [status, setStatus] = useState("ALL");
  const [doctor, setDoctor] = useState("");
  const [filters, setFilters] = useState({ start, end, place, status });
  const [booking, setBooking] = useState(false);
  useLayoutEffect(() => pinAmigoConnection(config.connection_id), [config.connection_id]);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState("");
  const [syncMessage, setSyncMessage] = useState("");
  const placesLoader = useCallback(() => read<Named[]>("places"), []);
  const places = useLoad(placesLoader, config.configured);
  const doctorsLoader = useCallback(() => read<Named[]>("doctors"), []);
  const doctors = useLoad(doctorsLoader, config.configured);
  const loader = useCallback(
    () =>
      read<Attendance[]>(
        canManage && !patient ? "attendances" : "patient_attendances",
        {
          ...(patient ? { patient_id: patient.id } : { status: filters.status }),
          start_date: filters.start,
          end_date: filters.end,
          ...(filters.place ? { place_id: Number(filters.place) } : {}),
        },
        contactId,
      ),
    [canManage, patient, filters, contactId],
  );
  const appointments = useLoad(loader, config.configured && (canManage || !!patient));
  const sync = async () => {
    setSyncing(true);
    setSyncError("");
    setSyncMessage("");
    try {
      await amigoRequest("/sync", "POST", {});
      setSyncMessage(t("Sincronização concluída. Confira as consultas atualizadas."));
      await onSync?.();
      await appointments.refresh();
    } catch (error) {
      setSyncError(errorText(error));
    } finally {
      setSyncing(false);
    }
  };
  if (!config.configured)
    return (
      <Panel title={t("Agenda Amigo")}>
        <p className="text-sm">
          {t("Configure a conexão na aba Configuração para consultar a agenda.")}
        </p>
      </Panel>
    );
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {t("Agenda do Amigo")} · {config.timezone}
        </p>
        <div className="flex flex-wrap gap-2">
          {canManage && (
            <Button variant="outline" disabled={syncing} onClick={() => void sync()}>
              {t("Sincronizar agora")}
            </Button>
          )}
          <Button onClick={() => setBooking(!booking)}>
            {booking ? t("Fechar nova consulta") : t("Nova consulta")}
          </Button>
        </div>
      </div>
      <Notice error={syncError} loading={syncing} />
      {syncMessage && (
        <p role="status" className="text-sm">
          {syncMessage}
        </p>
      )}
      {booking && (
        <AmigoBooking
          initialConfig={config}
          contactId={contactId}
          disabled={!canManage && !contactId}
          onSaved={() => void appointments.refresh()}
        />
      )}
      <Panel
        title={t("Consultas")}
        description={t(
          "Estados refletidos pelo Amigo. Atualize após uma alteração ou um resultado incerto.",
        )}
      >
        <PatientPicker
          selected={patient}
          onSelect={setPatient}
          contactId={contactId}
          disabled={!canManage && !contactId}
        />
        {!canManage && !patient && (
          <p className="text-sm">
            {t("Selecione um contato destinatário e o paciente para consultar seus atendimentos.")}
          </p>
        )}
        <form
          className="grid items-end gap-3 sm:grid-cols-2 xl:grid-cols-6"
          onSubmit={(e) => {
            e.preventDefault();
            setFilters({ start, end, place, status });
          }}
        >
          <Field label={t("De")}>
            <Input
              type="date"
              required
              value={start}
              onChange={(e) => setStart(e.target.value)}
              max={end}
            />
          </Field>
          <Field label={t("Até")}>
            <Input
              type="date"
              required
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              min={start}
            />
          </Field>
          <Pick
            label={t("Unidade da consulta")}
            value={place}
            placeholder={t("Todas as unidades")}
            options={options(places.data)}
            onChange={(e) => setPlace(e.target.value)}
          />
          <Pick
            label={t("Médico da consulta")}
            value={doctor}
            placeholder={t("Todos os médicos")}
            options={options(doctors.data)}
            onChange={(e) => setDoctor(e.target.value)}
          />
          <Pick
            label={t("Estado da consulta")}
            value={status}
            placeholder=""
            options={[
              { value: "ALL", label: t("Todos os estados") },
              ...Object.entries(statuses)
                .filter(([key]) => key !== "scheduled")
                .map(([key]) => ({ value: key.toUpperCase(), label: t(statuses[key]!) })),
            ]}
            onChange={(e) => setStatus(e.target.value)}
          />
          <Button variant="outline" disabled={appointments.loading || start > end}>
            {t("Atualizar agenda")}
          </Button>
        </form>
        <Notice
          error={appointments.error || places.error || doctors.error}
          loading={appointments.loading}
        />
        {appointments.data && (
          <AttendanceList
            items={appointments.data.filter(
              (item) =>
                (!doctor || (item.user_id ?? item.user?.id) === Number(doctor)) &&
                (!patient || status === "ALL" || attendanceStatus(item).toUpperCase() === status),
            )}
            timezone={config.timezone}
            contactId={contactId}
            onChanged={() => void appointments.refresh()}
          />
        )}
      </Panel>
    </div>
  );
}
