"use client";
import { useT } from "@/hooks/i18n/useT";
import { useCallback, useRef, useState } from "react";
import { apiClient } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { amigoRequest, errorText, read } from "./_api";
import { useAmigoMutation, useLoad } from "./_hooks";
import { PatientPicker } from "./_patient-picker";
import { AttendanceList } from "./_agenda";
import {
  CatalogTable,
  Field,
  MutationNotice,
  Notice,
  Panel,
  Pick,
  options,
  clinicDate,
} from "./_ui";
import type { AmigoSafeConfig, Attendance, Named, Patient } from "./_types";
import type { ContactChoice } from "./_contacts";

type Lead = {
  id: string;
  title: string | null;
  funil_nome?: string | null;
  etapa_nome?: string | null;
};
type Links = { links: { patient_id: number; contact_id: string; lead_id: string | null }[] };
export function AmigoPatients({
  config,
  contact,
  canManage,
}: {
  config: AmigoSafeConfig;
  contact: ContactChoice | null;
  canManage: boolean;
}) {
  const t = useT();
  const [patient, setPatient] = useState<Patient | null>(null);
  const [creating, setCreating] = useState(false);
  const [birthday, setBirthday] = useState("");
  const birthdayLoader = useCallback(
    () => read<Patient[]>("patient_birthdays", { date: birthday }),
    [birthday],
  );
  const birthdays = useLoad(birthdayLoader, !!birthday && canManage);
  return (
    <div className="space-y-6">
      <Panel
        title={t("Pacientes")}
        description={t(
          "Busque por CPF ou telefone e escolha a pessoa. Responsável e dependente podem compartilhar o mesmo número.",
        )}
      >
        <PatientPicker
          selected={patient}
          onSelect={(value) => {
            setPatient(value);
            setCreating(false);
          }}
          contactId={contact?.id}
          disabled={!canManage && !contact}
        />
        {!canManage && !contact && (
          <p className="text-sm">{t("Escolha o contato destinatário acima para consultar pacientes.")}</p>
        )}
        <Button
          variant="outline"
          disabled={!canManage && !contact}
          onClick={() => setCreating(!creating)}
        >
          {creating ? t("Fechar cadastro") : t("Cadastrar paciente")}
        </Button>
        {creating && (
          <PatientForm
            key="new"
            contactId={contact?.id}
            onSaved={(value) => {
              setPatient(value);
              setCreating(false);
            }}
          />
        )}
      </Panel>
      {patient && (
        <PatientDetails
          key={patient.id}
          patient={patient}
          contact={contact}
          timezone={config.timezone}
          onUpdated={setPatient}
          canManage={canManage}
        />
      )}
      {canManage && (
        <Panel
          title={t("Aniversariantes")}
          description={`${t("Consulta administrativa pelas datas da clínica")} (${config.timezone}). ${t("Não envia mensagens.")}`}
        >
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => setBirthday(clinicDate(config.timezone).slice(5))}
            >
              {t("Aniversariantes de hoje")}
            </Button>
            <Button
              variant="outline"
              onClick={() => setBirthday(clinicDate(config.timezone, true).slice(5))}
            >
              {t("Aniversariantes de amanhã")}
            </Button>
          </div>
          <Notice error={birthdays.error} loading={birthdays.loading} />
          {birthdays.data && (
            <div className="space-y-2">
              {birthdays.data.length === 0 && (
                <p className="text-sm">{t("Nenhum aniversariante nesta data.")}</p>
              )}
              {birthdays.data.map((value) => (
                <div
                  key={value.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
                >
                  <span>
                    {value.name ?? t("Sem nome")} ·{" "}
                    {value.contact_cellphone ?? t("Telefone não informado")}
                  </span>
                  <Button variant="outline" onClick={() => setPatient(value)}>
                    {t("Selecionar")} {value.name}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </Panel>
      )}
    </div>
  );
}
function PatientDetails({
  patient,
  contact,
  timezone,
  onUpdated,
  canManage,
}: {
  patient: Patient;
  contact: ContactChoice | null;
  timezone: string;
  onUpdated: (value: Patient) => void;
  canManage: boolean;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [showDoctors, setShowDoctors] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const loader = useCallback(
    () => read<Patient>("patient_get", { patientId: patient.id }, contact?.id),
    [patient.id, contact?.id],
  );
  const details = useLoad(loader);
  const doctorsLoader = useCallback(
    () => read<Named[]>("patient_doctors", { patientId: patient.id }, contact?.id),
    [patient.id, contact?.id],
  );
  const doctors = useLoad(doctorsLoader, showDoctors);
  const historyLoader = useCallback(
    () => read<Attendance[]>("patient_attendances", { patient_id: patient.id }, contact?.id),
    [patient.id, contact?.id],
  );
  const history = useLoad(historyLoader, showHistory);
  const value = details.data ?? patient;
  return (
    <>
      <Panel title={t("Cadastro do paciente")}>
        <Notice error={details.error} loading={details.loading} />
        <dl className="grid gap-4 text-sm sm:grid-cols-2 xl:grid-cols-4">
          {[
            [t("Nome"), value.name],
            [t("CPF"), value.cpf],
            [t("Telefone"), value.contact_cellphone],
            [t("E-mail"), value.email],
            [t("Idade"), value.age == null ? null : `${value.age} ${t("anos")}`],
            [t("Convênio"), value.health_insurance?.name],
          ].map(([label, text]) => (
            <div key={label}>
              <dt className="text-muted-foreground">{label}</dt>
              <dd>{text ?? t("Não informado")}</dd>
            </div>
          ))}
        </dl>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setEditing(!editing)}>
            {editing ? t("Fechar edição") : t("Editar paciente")}
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setShowDoctors(true);
              if (showDoctors) void doctors.refresh();
            }}
          >
            {t("Médicos do paciente")}
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setShowHistory(true);
              if (showHistory) void history.refresh();
            }}
          >
            {t("Histórico de consultas")}
          </Button>
          <Button variant="ghost" onClick={() => void details.refresh()}>
            {t("Atualizar cadastro")}
          </Button>
        </div>
        {editing && (
          <PatientForm
            key={JSON.stringify(value)}
            patient={value}
            contactId={contact?.id}
            onSaved={(updated) => {
              onUpdated(updated);
              setEditing(false);
              void details.refresh();
            }}
          />
        )}
        {showDoctors && (
          <div className="space-y-3">
            <h3 className="font-medium">{t("Profissionais que atenderam este paciente")}</h3>
            <Notice error={doctors.error} loading={doctors.loading} />
            {doctors.data && <CatalogTable items={doctors.data} />}
          </div>
        )}
        {showHistory && (
          <div className="space-y-3">
            <h3 className="font-medium">{t("Consultas do paciente")}</h3>
            <Notice error={history.error} loading={history.loading} />
            {history.data && (
              <AttendanceList
                items={history.data}
                timezone={timezone}
                contactId={contact?.id}
                onChanged={() => void history.refresh()}
              />
            )}
          </div>
        )}
      </Panel>
      <PatientLink
        key={`${patient.id}:${contact?.id ?? ""}`}
        patient={patient}
        contact={contact}
        canManage={canManage}
      />
    </>
  );
}
function PatientLink({
  patient,
  contact,
  canManage,
}: {
  patient: Patient;
  contact: ContactChoice | null;
  canManage: boolean;
}) {
  const t = useT();
  const [lead, setLead] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [manual, setManual] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const lock = useRef(false);
  const leadsLoader = useCallback(
    async () =>
      (
        await apiClient.get<{ data: { leads: Lead[] } }>(
          `/api/v1/contacts/${contact?.id}/crm-summary`,
        )
      ).data.leads,
    [contact?.id],
  );
  const leads = useLoad(leadsLoader, !!contact);
  const linksLoader = useCallback(
    () => amigoRequest<Links>(`/links?contact_id=${encodeURIComponent(contact?.id ?? "")}`),
    [contact?.id],
  );
  const links = useLoad(linksLoader, !!contact);
  const link = async () => {
    if (!contact || !confirmed || lock.current) return;
    lock.current = true;
    setPending(true);
    setError("");
    setMessage("");
    try {
      await amigoRequest("/links", "POST", {
        patient_id: patient.id,
        contact_id: contact.id,
        ...(lead && lead !== "none" ? { lead_id: lead } : {}),
        ...(manual ? { manual: true } : {}),
      });
      setMessage(t("Vínculo confirmado. Este contato é o destinatário escolhido para o paciente."));
      await links.refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPending(false);
      lock.current = false;
    }
  };
  return (
    <Panel
      title={t("Vínculo com o CRM")}
      description={t(
        "O paciente recebe o atendimento; o contato é quem recebe a comunicação. Um telefone compartilhado não confirma esse vínculo.",
      )}
    >
      {!contact ? (
        <p className="text-sm">
          {t("Escolha o contato destinatário no início da página para vincular este paciente.")}
        </p>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void link();
          }}
        >
          <p className="text-sm">
            <strong>{patient.name}</strong> {t("será vinculado a")} <strong>{contact.name}</strong>.
          </p>
          {links.data?.links
            .filter((value) => value.patient_id === patient.id)
            .map((value) => (
              <p key={`${value.patient_id}:${value.lead_id ?? ""}`} className="text-sm">
                {t("Paciente já vinculado a este contato")}
                {value.lead_id
                  ? ` · ${leads.data?.find((lead) => lead.id === value.lead_id)?.title ?? t("Negócio associado")}`
                  : ` · ${t("Sem negócio associado")}`}
                .
              </p>
            ))}
          <Pick
            label={t("Negócio para este paciente")}
            value={lead}
            required={!!leads.data?.length}
            disabled={pending || leads.loading || !!leads.error}
            options={[
              { value: "none", label: t("Vincular somente ao contato") },
              ...(leads.data ?? []).map((value) => ({
                value: value.id,
                label: `${value.title ?? t("Sem título")}${value.funil_nome ? ` · ${value.funil_nome}` : ""}${value.etapa_nome ? ` · ${value.etapa_nome}` : ""}`,
              })),
            ]}
            onChange={(e) => {
              setLead(e.target.value);
              setConfirmed(false);
              setMessage("");
            }}
          />
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1 size-4"
              checked={confirmed}
              disabled={pending}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            <span>
              {t("Confirmo que")} {patient.name} {t("é o paciente correto e que")} {contact.name}{" "}
              {t("é o destinatário responsável por este atendimento.")}
            </span>
          </label>
          {canManage && (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1 size-4"
                checked={manual}
                disabled={pending}
                onChange={(e) => setManual(e.target.checked)}
              />
              <span>
                {t(
                  "Vincular mesmo que o paciente não apareça pelo telefone deste contato (fica registrado como vínculo manual).",
                )}
              </span>
            </label>
          )}
          <Button
            disabled={
              !confirmed ||
              pending ||
              leads.loading ||
              !!leads.error ||
              (!!leads.data?.length && !lead)
            }
          >
            {t("Vincular paciente ao contato")}
          </Button>
        </form>
      )}
      <Notice
        error={error || leads.error || links.error}
        loading={pending || leads.loading || links.loading}
      />
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
    </Panel>
  );
}
const patientFields = [
  ["contact_cellphone", "tel"],
  ["email", "email"],
  ["cpf", "text"],
  ["cpf_responsible", "text"],
  ["insurance_number", "text"],
  ["mother_name", "text"],
  ["jobrole", "text"],
  ["civil_status", "text"],
  ["address_cep", "text"],
  ["address_address", "text"],
  ["address_number", "text"],
  ["address_district", "text"],
  ["address_city", "text"],
  ["address_state", "text"],
  ["address_country", "text"],
] as const;
function PatientForm({
  patient,
  contactId,
  onSaved,
}: {
  patient?: Patient;
  contactId?: string;
  onSaved: (value: Patient) => void;
}) {
  const t = useT();
  const rotulos: Record<(typeof patientFields)[number][0], string> = {
    contact_cellphone: t("Telefone"),
    email: t("E-mail"),
    cpf: t("CPF do paciente"),
    cpf_responsible: t("CPF do responsável"),
    insurance_number: t("Carteirinha do convênio"),
    mother_name: t("Nome da mãe"),
    jobrole: t("Profissão"),
    civil_status: t("Estado civil"),
    address_cep: t("CEP"),
    address_address: t("Endereço"),
    address_number: t("Número"),
    address_district: t("Bairro"),
    address_city: t("Cidade"),
    address_state: t("Estado"),
    address_country: t("País"),
  };
  const [initial] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      ["name", "gender", "insurance_id", ...patientFields.map(([name]) => name)].map((name) => [
        name,
        (typeof patient?.[name] === "string" || typeof patient?.[name] === "number") &&
        !/[*•]/.test(String(patient[name]))
          ? String(patient[name])
          : "",
      ]),
    ),
  );
  const [values, setValues] = useState(initial);
  const mutation = useAmigoMutation();
  const insurancesLoader = useCallback(() => read<Named[]>("insurances"), []);
  const insurances = useLoad(insurancesLoader);
  const set = (key: string, value: string) =>
    setValues((current) => ({ ...current, [key]: value }));
  const save = async () => {
    const input = Object.fromEntries(
      Object.entries(values)
        .filter(
          ([key, value]) => value.trim() && (!patient || key === "name" || value !== initial[key]),
        )
        .map(([key, value]) => [key, key === "insurance_id" ? Number(value) : value.trim()]),
    );
    const receipt = await mutation.run(
      patient ? "patient_update" : "patient_create",
      { ...input, ...(patient ? { patientId: patient.id } : {}) },
      contactId,
    );
    if (receipt) onSaved(receipt.data as Patient);
  };
  return (
    <form
      className="space-y-4 rounded-md border p-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <p className="text-sm font-medium">
        {patient ? t("Atualizar cadastro no Amigo") : t("Novo paciente no Amigo")}
      </p>
      <fieldset
        disabled={mutation.pending || mutation.blocked}
        className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
      >
        <Field label={t("Nome do paciente")}>
          <Input
            required
            maxLength={500}
            value={values.name}
            onChange={(e) => set("name", e.target.value)}
          />
        </Field>
        <Pick
          label={t("Sexo do paciente")}
          value={values.gender}
          placeholder={t("Não informar")}
          options={[
            { value: "Masculino", label: t("Masculino") },
            { value: "Feminino", label: t("Feminino") },
          ]}
          onChange={(e) => set("gender", e.target.value)}
        />
        <Pick
          label={t("Convênio do paciente")}
          value={values.insurance_id}
          placeholder={t("Não informar")}
          options={options(insurances.data)}
          onChange={(e) => set("insurance_id", e.target.value)}
        />
        {patientFields.map(([key, type]) => (
          <Field key={key} label={rotulos[key]}>
            <Input
              type={type}
              maxLength={key === "civil_status" ? 25 : key === "email" ? 320 : 500}
              value={values[key]}
              onChange={(e) => set(key, e.target.value)}
            />
          </Field>
        ))}
      </fieldset>
      <p className="text-xs text-muted-foreground">
        {t(
          "Campos vazios e dados que você não alterou são preservados. Dados protegidos aparecem vazios; preencha apenas se quiser substituí-los. A clínica pode exigir informações adicionais.",
        )}
      </p>
      <Button disabled={!values.name?.trim() || mutation.pending || mutation.blocked}>
        {patient ? t("Salvar paciente") : t("Criar paciente no Amigo")}
      </Button>
      <Notice error={insurances.error} loading={insurances.loading} />
      <MutationNotice mutation={mutation} />
    </form>
  );
}
