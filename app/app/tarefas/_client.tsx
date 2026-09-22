"use client";

import * as React from "react";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { paraCSV } from "@/lib/comercial/relatorios";
import { ROTULO_STATUS_TAREFA, ROTULO_TIPO_TAREFA, type Tarefa } from "@/lib/schemas/tarefas";

interface Atividade {
  id: string;
  contact_id: string | null;
  contato_nome: string | null;
  tipo: string;
  resultado: string | null;
  observacao: string | null;
  ocorrida_em: string;
}

const PILL_STATUS: Record<string, string> = {
  pendente: "bg-yellow-100 text-yellow-800",
  concluida: "bg-green-100 text-green-800",
  cancelada: "bg-muted text-muted-foreground",
};

export function TarefasClient({ podeRegistrar }: { podeRegistrar: boolean }) {
  const tagIdioma = useTagDeIdioma();
  const t = useT();
  const [aba, setAba] = React.useState<"tarefas" | "atividades">("tarefas");
  const [tarefas, setTarefas] = React.useState<Tarefa[]>([]);
  const [atividades, setAtividades] = React.useState<Atividade[]>([]);
  const [carregando, setCarregando] = React.useState(true);
  const [titulo, setTitulo] = React.useState("");
  const [data, setData] = React.useState("");
  const [tipoAtv, setTipoAtv] = React.useState("visita");
  const [resultadoAtv, setResultadoAtv] = React.useState("");
  const [obsAtv, setObsAtv] = React.useState("");

  async function carregarTarefas() {
    try {
      const corpo = await apiClient.get<{ data: Tarefa[] }>("/api/v1/tarefas");
      setTarefas(corpo.data ?? []);
    } catch (e) {
      showApiError(e);
    }
  }

  async function carregarAtividades() {
    try {
      const corpo = await apiClient.get<{ data: Atividade[] }>("/api/v1/atividades");
      setAtividades(corpo.data ?? []);
    } catch (e) {
      showApiError(e);
    }
  }

  React.useEffect(() => {
    let vivo = true;
    void (async () => {
      setCarregando(true);
      await Promise.all([carregarTarefas(), carregarAtividades()]);
      if (vivo) setCarregando(false);
    })();
    return () => {
      vivo = false;
    };
  }, []);

  async function criarTarefa() {
    if (titulo.trim().length < 2) {
      toast.error("Dê um título para a tarefa.");
      return;
    }
    try {
      await apiClient.post("/api/v1/tarefas", {
        titulo: titulo.trim(),
        agendada_para: data || null,
      });
      toast.success("Tarefa criada");
      setTitulo("");
      setData("");
      await carregarTarefas();
    } catch (e) {
      showApiError(e);
    }
  }

  async function mudarStatus(id: string, status: "concluida" | "cancelada" | "pendente") {
    try {
      await apiClient.patch(`/api/v1/tarefas/${id}`, { status });
      await carregarTarefas();
    } catch (e) {
      showApiError(e);
    }
  }

  function checkin(id: string) {
    if (!("geolocation" in navigator)) {
      toast.error("Este aparelho não informa localização.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        void apiClient
          .patch(`/api/v1/tarefas/${id}`, {
            checkin_lat: Number(pos.coords.latitude.toFixed(6)),
            checkin_lng: Number(pos.coords.longitude.toFixed(6)),
          })
          .then(() => {
            toast.success("Check-in registrado");
            return carregarTarefas();
          })
          .catch(showApiError);
      },
      () => toast.error("Permita a localização para o check-in."),
      { timeout: 15000 },
    );
  }

  async function registrarAtividade() {
    try {
      await apiClient.post("/api/v1/atividades", {
        tipo: tipoAtv,
        resultado: resultadoAtv.trim() || undefined,
        observacao: obsAtv.trim() || undefined,
      });
      toast.success("Atividade registrada");
      setResultadoAtv("");
      setObsAtv("");
      await carregarAtividades();
    } catch (e) {
      showApiError(e);
    }
  }

  function exportar() {
    const blob = new Blob(
      [
        "﻿" +
          paraCSV(
            ["Data", "Tipo", "Cliente", "Resultado", "Observação"],
            atividades.map((a) => [
              new Date(a.ocorrida_em).toLocaleDateString(tagIdioma),
              a.tipo,
              a.contato_nome ?? "",
              a.resultado ?? "",
              a.observacao ?? "",
            ]),
          ),
      ],
      { type: "text/csv;charset=utf-8" },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "atividades.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  const pendentes = tarefas.filter((t) => t.status === "pendente");

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <PageHeader
        title={t("Tarefas")}
        subtitle={t("Agendadas, check-in de visita e atividades realizadas.")}
        actions={
          <div className="flex gap-2">
            <Button size="sm" variant={aba === "tarefas" ? "default" : "outline"} onClick={() => setAba("tarefas")}>
              {t("Tarefas")} ({pendentes.length})
            </Button>
            <Button size="sm" variant={aba === "atividades" ? "default" : "outline"} onClick={() => setAba("atividades")}>
              {t("Atividades")}
            </Button>
          </div>
        }
      />

      {carregando ? (
        <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>
      ) : aba === "tarefas" ? (
        <>
          {podeRegistrar && (
            <Card className="flex flex-wrap items-end gap-2 p-3">
              <label className="min-w-52 flex-1 text-sm">
                <span className="mb-1 block text-muted-foreground">{t("Nova tarefa")}</span>
                <Input value={titulo} onChange={(e) => setTitulo(e.target.value)} placeholder={t("Visitar cliente X…")} />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block text-muted-foreground">{t("Data")}</span>
                <Input type="date" value={data} onChange={(e) => setData(e.target.value)} />
              </label>
              <Button size="sm" onClick={() => void criarTarefa()}>
                {t("Criar tarefa")}
              </Button>
            </Card>
          )}
          {tarefas.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("Nenhuma tarefa. Crie a primeira acima.")}</p>
          ) : (
            <div className="space-y-2">
              {tarefas.map((tarefa) => (
                <Card key={tarefa.id} className="flex flex-wrap items-center gap-2 p-3">
                  <div className="min-w-48 flex-1">
                    <p className="font-medium">{tarefa.titulo}</p>
                    <p className="text-xs text-muted-foreground">
                      {ROTULO_TIPO_TAREFA[tarefa.tipo as keyof typeof ROTULO_TIPO_TAREFA] ?? tarefa.tipo}
                      {tarefa.contato_nome ? ` · ${tarefa.contato_nome}` : ""}
                      {tarefa.agendada_para
                        ? ` · ${new Date(`${tarefa.agendada_para}T12:00:00Z`).toLocaleDateString(tagIdioma)}`
                        : ""}
                      {tarefa.checkin_em ? ` · ${t("check-in feito")}` : ""}
                    </p>
                  </div>
                  <span
                    className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${PILL_STATUS[tarefa.status] ?? PILL_STATUS.pendente}`}
                  >
                    {ROTULO_STATUS_TAREFA[tarefa.status as keyof typeof ROTULO_STATUS_TAREFA] ?? tarefa.status}
                  </span>
                  {podeRegistrar && tarefa.status === "pendente" && (
                    <>
                      <Button size="sm" variant="outline" onClick={() => checkin(tarefa.id)}>
                        {t("Check-in")}
                      </Button>
                      <Button size="sm" onClick={() => void mudarStatus(tarefa.id, "concluida")}>
                        {t("Concluir")}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => void mudarStatus(tarefa.id, "cancelada")}>
                        {t("Cancelar")}
                      </Button>
                    </>
                  )}
                  {podeRegistrar && tarefa.status !== "pendente" && (
                    <Button size="sm" variant="outline" onClick={() => void mudarStatus(tarefa.id, "pendente")}>
                      {t("Reabrir")}
                    </Button>
                  )}
                </Card>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          {podeRegistrar && (
            <Card className="flex flex-wrap items-end gap-2 p-3">
              <label className="block text-sm">
                <span className="mb-1 block text-muted-foreground">{t("Tipo")}</span>
                <select
                  value={tipoAtv}
                  onChange={(e) => setTipoAtv(e.target.value)}
                  className="h-9 rounded-lg border bg-background px-3"
                >
                  <option value="visita">{t("Visita")}</option>
                  <option value="ligacao">{t("Ligação")}</option>
                  <option value="whatsapp">WhatsApp</option>
                  <option value="email">{t("E-mail")}</option>
                  <option value="outro">{t("Outra")}</option>
                </select>
              </label>
              <label className="min-w-40 flex-1 text-sm">
                <span className="mb-1 block text-muted-foreground">{t("Resultado")}</span>
                <Input
                  value={resultadoAtv}
                  onChange={(e) => setResultadoAtv(e.target.value)}
                  placeholder={t("Pedido feito, sem interesse…")}
                />
              </label>
              <label className="min-w-40 flex-1 text-sm">
                <span className="mb-1 block text-muted-foreground">{t("Observação")}</span>
                <Input value={obsAtv} onChange={(e) => setObsAtv(e.target.value)} placeholder={t("Detalhe…")} />
              </label>
              <Button size="sm" onClick={() => void registrarAtividade()}>
                {t("Registrar atividade")}
              </Button>
              <Button size="sm" variant="outline" onClick={exportar}>
                Excel
              </Button>
            </Card>
          )}
          {atividades.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("Nenhuma atividade registrada.")}</p>
          ) : (
            <div className="overflow-x-auto rounded-3xl border">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40 hover:bg-muted/40">
                    <TableHead>{t("Data")}</TableHead>
                    <TableHead>{t("Tipo")}</TableHead>
                    <TableHead>{t("Cliente")}</TableHead>
                    <TableHead>{t("Resultado")}</TableHead>
                    <TableHead>{t("Observação")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {atividades.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell className="text-muted-foreground">
                        {new Date(a.ocorrida_em).toLocaleDateString(tagIdioma)}
                      </TableCell>
                      <TableCell>{a.tipo}</TableCell>
                      <TableCell>{a.contato_nome ?? "—"}</TableCell>
                      <TableCell>{a.resultado ?? "—"}</TableCell>
                      <TableCell className="max-w-64 truncate">{a.observacao ?? "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
