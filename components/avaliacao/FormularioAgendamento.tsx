"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { useContatoPorTelefone } from "@/hooks/avaliacao/useContatoPorTelefone";
import type { UnidadeAvaliacao } from "@/hooks/avaliacao/useUnidadesAvaliacao";
import { useT } from "@/hooks/i18n/useT";
import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";
import { apiClient } from "@/lib/api/client";
import { MARCAS_VEICULOS } from "@/lib/avaliacao/marcas-veiculos";

import type { AgendamentoAvaliacao } from "./tipos";

function embedContato(item: AgendamentoAvaliacao | null) {
  if (!item?.contacts) return { name: "", phone: "", email: "" };
  const c = Array.isArray(item.contacts) ? item.contacts[0] : item.contacts;
  return {
    name: c?.name ?? "",
    phone: c?.phone_number ?? "",
    email: c?.email ?? item.client_email ?? "",
  };
}

export function FormularioAgendamento({
  aberto,
  onAbertoChange,
  edicao,
  unidades,
  aoSalvar,
  onAgendamentoSalvo,
}: {
  aberto: boolean;
  onAbertoChange: (v: boolean) => void;
  edicao: AgendamentoAvaliacao | null;
  unidades: UnidadeAvaliacao[];
  aoSalvar?: () => void;
  /** Leva a agenda para a semana do horário salvo (evita lista “vazia” fora do filtro). */
  onAgendamentoSalvo?: (scheduledAtIso: string) => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const membros = useAssignableMembers(aberto);

  const [nome, setNome] = useState("");
  const [telefone, setTelefone] = useState("");
  const [email, setEmail] = useState("");
  const [unitId, setUnitId] = useState("");
  const [consultantAuto, setConsultantAuto] = useState(true);
  const [consultantId, setConsultantId] = useState<string | "">("");
  const [attendantId, setAttendantId] = useState<string | "">("");
  const [data, setData] = useState("");
  const [hora, setHora] = useState("09:00");
  const [placa, setPlaca] = useState("");
  const [marca, setMarca] = useState("");
  const [modelo, setModelo] = useState("");
  const [notas, setNotas] = useState("");

  const contatoLookup = useContatoPorTelefone(telefone);

  useEffect(() => {
    if (!aberto) return;
    if (edicao) {
      const c = embedContato(edicao);
      setNome(c.name);
      setTelefone(c.phone);
      setEmail(c.email);
      setUnitId(edicao.unit_id);
      setConsultantAuto(false);
      setConsultantId(edicao.consultant_user_id ?? "");
      setAttendantId(edicao.attendant_user_id ?? "");
      const quando = new Date(edicao.scheduled_at);
      setData(format(quando, "yyyy-MM-dd"));
      setHora(
        `${String(quando.getHours()).padStart(2, "0")}:${String(quando.getMinutes()).padStart(2, "0")}`,
      );
      setPlaca(edicao.vehicle_plate ?? "");
      setMarca(edicao.vehicle_brand ?? "");
      setModelo(edicao.vehicle_model ?? "");
      setNotas(edicao.notes ?? "");
    } else {
      setNome("");
      setTelefone("");
      setEmail("");
      setUnitId(unidades.find((u) => u.is_active)?.id ?? "");
      setConsultantAuto(true);
      setConsultantId("");
      setAttendantId("");
      setData(format(new Date(), "yyyy-MM-dd"));
      setHora("09:00");
      setPlaca("");
      setMarca("");
      setModelo("");
      setNotas("");
    }
  }, [aberto, edicao, unidades]);

  useEffect(() => {
    if (contatoLookup.data && !edicao) {
      setNome(contatoLookup.data.name);
    }
  }, [contatoLookup.data, edicao]);

  const salvar = useMutation({
    mutationFn: async () => {
      if (!unitId) throw new Error("Selecione a unidade.");
      if (!telefone.trim() || !nome.trim()) {
        throw new Error("Informe WhatsApp e nome do cliente.");
      }
      const scheduledAt = new Date(`${data}T${hora}:00`).toISOString();
      const corpoBase = {
        unit_id: unitId,
        scheduled_at: scheduledAt,
        duration_minutes: 20,
        client_name: nome.trim() || undefined,
        client_phone: telefone.trim() || undefined,
        client_email: email.trim() || undefined,
        contact_id: contatoLookup.data?.id,
        consultant_auto: consultantAuto,
        consultant_user_id: consultantAuto ? null : consultantId || null,
        attendant_user_id: attendantId || null,
        vehicle_plate: placa.trim() || undefined,
        vehicle_brand: marca.trim() || undefined,
        vehicle_model: modelo.trim() || undefined,
        notes: notas.trim() || undefined,
      };

      if (edicao) {
        await apiClient.patch(`/api/v1/avaliacao/agendamentos/${edicao.id}`, corpoBase);
        return scheduledAt;
      }
      await apiClient.post("/api/v1/avaliacao/agendamentos", corpoBase);
      return scheduledAt;
    },
    onSuccess: (scheduledAt) => {
      void qc.invalidateQueries({ queryKey: ["avaliacao", "agendamentos"] });
      toast.success(edicao ? "Agendamento atualizado." : "Agendamento criado.");
      onAgendamentoSalvo?.(scheduledAt);
      onAbertoChange(false);
      aoSalvar?.();
    },
    onError: (err) => {
      if (err instanceof Error && err.message) {
        toast.error(err.message);
        return;
      }
      showApiError(err);
    },
  });

  return (
    <Sheet open={aberto} onOpenChange={onAbertoChange}>
      <SheetContent className="flex w-full flex-col overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{edicao ? "Editar agendamento" : "Novo agendamento"}</SheetTitle>
        </SheetHeader>

        <div className="flex flex-1 flex-col gap-6 py-4">
          <section className="space-y-3">
            <h3 className="text-sm font-medium">Cliente</h3>
            <div className="space-y-2">
              <Label htmlFor="av-telefone">WhatsApp</Label>
              <Input id="av-telefone" value={telefone} onChange={(e) => setTelefone(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="av-nome">Nome</Label>
              <Input id="av-nome" value={nome} onChange={(e) => setNome(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="av-email">E-mail (opcional)</Label>
              <Input id="av-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-medium">Agendamento</h3>
            <div className="space-y-2">
              <Label>Unidade</Label>
              <Select value={unitId} onValueChange={setUnitId} disabled={unidades.filter((u) => u.is_active).length === 0}>
                <SelectTrigger>
                  <SelectValue
                    placeholder={
                      unidades.filter((u) => u.is_active).length === 0
                        ? "Cadastre uma unidade acima"
                        : "Selecione"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {unidades
                    .filter((u) => u.is_active)
                    .map((u) => (
                      <SelectItem key={u.id} value={u.id}>
                        {u.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              {unidades.filter((u) => u.is_active).length === 0 ? (
                <p className="text-xs text-destructive">Nenhuma unidade ativa — crie uma antes de salvar.</p>
              ) : null}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-2">
                <Label htmlFor="av-data">Data</Label>
                <Input id="av-data" type="date" value={data} onChange={(e) => setData(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="av-hora">{t("Horário")}</Label>
                <Input id="av-hora" type="time" value={hora} onChange={(e) => setHora(e.target.value)} />
              </div>
            </div>
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="av-consultor-auto">Distribuir consultor automaticamente</Label>
              <Switch
                id="av-consultor-auto"
                checked={consultantAuto}
                onCheckedChange={(checked: boolean) => setConsultantAuto(checked)}
              />
            </div>
            {!consultantAuto && (
              <div className="space-y-2">
                <Label>Consultor</Label>
                <Select value={consultantId} onValueChange={setConsultantId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Selecione" />
                  </SelectTrigger>
                  <SelectContent>
                    {membros.data?.map((m) => (
                      <SelectItem key={m.user_id} value={m.user_id}>
                        {m.full_name ?? m.user_id.slice(0, 8)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-2">
              <Label>Atendente (opcional)</Label>
              <Select value={attendantId || "_none"} onValueChange={(v) => setAttendantId(v === "_none" ? "" : v)}>
                <SelectTrigger>
                  <SelectValue placeholder={t("Nenhum")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="_none">{t("Nenhum")}</SelectItem>
                  {membros.data?.map((m) => (
                    <SelectItem key={m.user_id} value={m.user_id}>
                        {m.full_name ?? m.user_id.slice(0, 8)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-medium">{t("Veículo")}</h3>
            <div className="space-y-2">
              <Label>Marca</Label>
              <Select value={marca || "_none"} onValueChange={(v) => setMarca(v === "_none" ? "" : v)}>
                <SelectTrigger>
                  <SelectValue placeholder="Opcional" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="_none">—</SelectItem>
                  {MARCAS_VEICULOS.map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="av-modelo">Modelo</Label>
              <Input id="av-modelo" value={modelo} onChange={(e) => setModelo(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="av-placa">Placa</Label>
              <Input id="av-placa" value={placa} onChange={(e) => setPlaca(e.target.value.toUpperCase())} />
            </div>
          </section>

          <section className="space-y-2">
            <Label htmlFor="av-notas">{t("Observações")}</Label>
            <Textarea id="av-notas" value={notas} onChange={(e) => setNotas(e.target.value)} rows={3} />
          </section>
        </div>

        <SheetFooter className="gap-2 sm:gap-0">
          <Button type="button" variant="outline" onClick={() => onAbertoChange(false)}>
            Cancelar
          </Button>
          <Button type="button" onClick={() => salvar.mutate()} disabled={salvar.isPending}>
            {salvar.isPending ? "Salvando…" : "Salvar"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
