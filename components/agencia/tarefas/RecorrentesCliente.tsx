"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { excluirRecorrente, salvarRecorrente } from "@/app/actions/agencia/recorrentes";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  DIAS_DA_SEMANA,
  PADROES,
  PRIORIDADES,
  ROTULO_DA_PRIORIDADE,
  ROTULO_DO_PADRAO,
  type Padrao,
  type Prioridade,
} from "@/lib/agencia/tarefas/vocabulario";
import { formatarDataHora } from "@/lib/agencia/tarefas/regras";
import { cn } from "@/lib/utils";

import type { ApoioDoQuadro } from "./ModalDaTarefa";

export interface RecorrenteDaLista {
  id?: string;
  titulo: string;
  descricao: string;
  clienteId: string;
  funcaoId: string;
  prioridade: Prioridade;
  padrao: Padrao;
  diasSemana: number[];
  diaDoMes: number | null;
  hora: string;
  prazoEmHoras: number | null;
  inicio: string;
  fim: string;
  ativa: boolean;
  proximaExecucao?: string | null;
  responsaveis: string[];
  etiquetas: string[];
}

function hoje(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function descreverPadrao(r: RecorrenteDaLista): string {
  if (r.padrao === "diaria") return `Todo dia às ${r.hora}`;
  if (r.padrao === "semanal") return `${r.diasSemana.map((d) => DIAS_DA_SEMANA[d]).join(", ")} às ${r.hora}`;
  return `Todo dia ${r.diaDoMes} às ${r.hora}`;
}

export function RecorrentesCliente({ recorrentes, apoio }: { recorrentes: RecorrenteDaLista[]; apoio: ApoioDoQuadro }) {
  const router = useRouter();
  const [editando, setEditando] = useState<RecorrenteDaLista | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [pendente, startTransition] = useTransition();
  const porCliente = new Map(apoio.clientes.map((c) => [c.id, c.nome]));

  const nova = (): RecorrenteDaLista => ({
    titulo: "",
    descricao: "",
    clienteId: "",
    funcaoId: "",
    prioridade: "media",
    padrao: "semanal",
    diasSemana: [5],
    diaDoMes: 1,
    hora: "08:00",
    prazoEmHoras: 24,
    inicio: hoje(),
    fim: "",
    ativa: true,
    responsaveis: [],
    etiquetas: [],
  });

  function salvar(r: RecorrenteDaLista) {
    setErro(null);
    startTransition(async () => {
      const res = await salvarRecorrente({
        id: r.id,
        titulo: r.titulo,
        descricao: r.descricao || null,
        clienteId: r.clienteId || null,
        funcaoId: r.funcaoId || null,
        prioridade: r.prioridade,
        padrao: r.padrao,
        diasSemana: r.diasSemana,
        diaDoMes: r.padrao === "mensal" ? r.diaDoMes : null,
        hora: r.hora,
        prazoEmHoras: r.prazoEmHoras,
        inicio: r.inicio,
        fim: r.fim || null,
        ativa: r.ativa,
        responsaveis: r.responsaveis,
        etiquetas: r.etiquetas,
      });
      if (res.ok) {
        setEditando(null);
        router.refresh();
      } else setErro(res.erro);
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setEditando(nova())}>Nova recorrente</Button>
      </div>
      {recorrentes.length === 0 ? (
        <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">Nenhuma tarefa recorrente.</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {recorrentes.map((r) => (
            <li key={r.id} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-0.5">
                <p className="font-medium">
                  {r.titulo}
                  {!r.ativa && <span className="ml-2 rounded-full bg-muted px-2 text-xs text-muted-foreground">Pausada</span>}
                </p>
                <p className="text-xs text-muted-foreground">
                  {descreverPadrao(r)}
                  {r.clienteId && ` · ${porCliente.get(r.clienteId) ?? "cliente"}`}
                  {r.proximaExecucao && ` · próxima: ${formatarDataHora(r.proximaExecucao, { comAno: true })}`}
                </p>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => setEditando(r)}>
                  Editar
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive"
                  disabled={pendente}
                  onClick={() =>
                    startTransition(async () => {
                      if (!window.confirm("Excluir esta recorrente? As tarefas já geradas ficam.")) return;
                      const res = await excluirRecorrente(r.id!);
                      if (!res.ok) setErro(res.erro);
                      router.refresh();
                    })
                  }
                >
                  Excluir
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {erro && !editando && (
        <p role="alert" className="text-sm text-destructive">
          {erro}
        </p>
      )}

      <Dialog open={editando !== null} onOpenChange={(v) => !v && setEditando(null)}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-xl">
          {editando && (
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                salvar(editando);
              }}
            >
              <DialogHeader>
                <DialogTitle>{editando.id ? "Editar recorrente" : "Nova recorrente"}</DialogTitle>
                <DialogDescription>A tarefa nasce na coluna "A fazer" e avisa os responsáveis.</DialogDescription>
              </DialogHeader>
              <div className="space-y-1.5">
                <Label htmlFor="rec-titulo">Título</Label>
                <Input id="rec-titulo" value={editando.titulo} onChange={(e) => setEditando({ ...editando, titulo: e.target.value })} required />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="rec-padrao">Repetir</Label>
                  <select
                    id="rec-padrao"
                    value={editando.padrao}
                    onChange={(e) => setEditando({ ...editando, padrao: e.target.value as Padrao })}
                    className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                  >
                    {PADROES.map((p) => (
                      <option key={p} value={p}>
                        {ROTULO_DO_PADRAO[p]}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="rec-hora">Hora</Label>
                  <Input id="rec-hora" type="time" value={editando.hora} onChange={(e) => setEditando({ ...editando, hora: e.target.value })} />
                </div>
              </div>
              {editando.padrao === "semanal" && (
                <div className="flex flex-wrap gap-2" role="group" aria-label="Dias da semana">
                  {DIAS_DA_SEMANA.map((d, i) => (
                    <button
                      key={d}
                      type="button"
                      aria-pressed={editando.diasSemana.includes(i)}
                      onClick={() =>
                        setEditando({
                          ...editando,
                          diasSemana: editando.diasSemana.includes(i) ? editando.diasSemana.filter((x) => x !== i) : [...editando.diasSemana, i].sort(),
                        })
                      }
                      className={cn(
                        "min-h-9 min-w-12 rounded-full border px-3 text-sm",
                        editando.diasSemana.includes(i) ? "border-foreground bg-foreground text-background" : "text-muted-foreground",
                      )}
                    >
                      {d}
                    </button>
                  ))}
                </div>
              )}
              {editando.padrao === "mensal" && (
                <div className="space-y-1.5">
                  <Label htmlFor="rec-dia">Dia do mês</Label>
                  <Input
                    id="rec-dia"
                    inputMode="numeric"
                    className="w-24"
                    value={editando.diaDoMes ?? ""}
                    onChange={(e) => setEditando({ ...editando, diaDoMes: Math.min(31, Math.max(1, Number(e.target.value.replace(/\D/g, "")) || 1)) })}
                  />
                </div>
              )}
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <Label htmlFor="rec-inicio">Começa em</Label>
                  <Input id="rec-inicio" type="date" value={editando.inicio} onChange={(e) => setEditando({ ...editando, inicio: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="rec-fim">Termina em (opcional)</Label>
                  <Input id="rec-fim" type="date" value={editando.fim} onChange={(e) => setEditando({ ...editando, fim: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="rec-prazo">Prazo (horas)</Label>
                  <Input
                    id="rec-prazo"
                    inputMode="numeric"
                    value={editando.prazoEmHoras ?? ""}
                    onChange={(e) => setEditando({ ...editando, prazoEmHoras: e.target.value ? Number(e.target.value.replace(/\D/g, "")) || null : null })}
                  />
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="rec-cliente">Cliente</Label>
                  <select
                    id="rec-cliente"
                    value={editando.clienteId}
                    onChange={(e) => setEditando({ ...editando, clienteId: e.target.value })}
                    className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                  >
                    <option value="">Interna</option>
                    {apoio.clientes.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.nome}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="rec-prioridade">Prioridade</Label>
                  <select
                    id="rec-prioridade"
                    value={editando.prioridade}
                    onChange={(e) => setEditando({ ...editando, prioridade: e.target.value as Prioridade })}
                    className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                  >
                    {PRIORIDADES.map((p) => (
                      <option key={p} value={p}>
                        {ROTULO_DA_PRIORIDADE[p]}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Responsáveis</legend>
                <div className="flex flex-wrap gap-2">
                  {apoio.membros.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      aria-pressed={editando.responsaveis.includes(m.id)}
                      onClick={() =>
                        setEditando({
                          ...editando,
                          responsaveis: editando.responsaveis.includes(m.id)
                            ? editando.responsaveis.filter((x) => x !== m.id)
                            : [...editando.responsaveis, m.id],
                        })
                      }
                      className={cn(
                        "min-h-9 rounded-full border px-3 text-sm",
                        editando.responsaveis.includes(m.id) ? "border-foreground bg-foreground text-background" : "text-muted-foreground",
                      )}
                    >
                      {m.nome}
                    </button>
                  ))}
                </div>
                <select
                  aria-label="Ou mandar para uma função"
                  value={editando.funcaoId}
                  onChange={(e) => setEditando({ ...editando, funcaoId: e.target.value })}
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                >
                  <option value="">Sem função</option>
                  {apoio.funcoes.map((f) => (
                    <option key={f.id} value={f.id}>
                      Função: {f.nome}
                    </option>
                  ))}
                </select>
              </fieldset>
              <label className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm">
                Ativa
                <Switch checked={editando.ativa} onCheckedChange={(v) => setEditando({ ...editando, ativa: v })} />
              </label>
              {erro && (
                <p role="alert" className="text-sm text-destructive">
                  {erro}
                </p>
              )}
              <div className="flex justify-end">
                <Button type="submit" disabled={pendente}>
                  {pendente ? "Salvando…" : "Salvar"}
                </Button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
