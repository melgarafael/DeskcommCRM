"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { apiClient } from "@/lib/api/client";
import type { CfopEquivalenteSalvo } from "@/lib/schemas/fiscal";
import { DownloadSimple, PencilSimple, Trash } from "@/lib/ui/icons";

import type { Textos } from "./textos";

type JobFiscal = {
  id: string;
  invoice_id: string;
  tipo: string;
  status: string;
  tentativas: number;
  max_tentativas: number;
  ultimo_erro: string | null;
  proxima_tentativa: string;
  created_at: string;
  nota: { numero: number | null; serie: string; status: string } | null;
};

type SpedResumo = {
  ano: number;
  mes: number;
  arquivo: string;
  linhas: number;
  notas: number;
  itens: number;
  inicio: string;
  fim: string;
  pendencias: string[];
  nomes: { sugestao: string };
};

/**
 * Aba "SPED Fiscal" — o menu do Odivix em ordem de uso: 1) CFOPs
 * equivalentes (o de/para que o arquivo usa), 2) Gera Arquivo (rascunho para
 * o PVA), 3) Manutenção (a fila fiscal aberta).
 */
export function SpedFiscal({
  equivalentesIniciais,
  podeConfigurar,
  textos,
}: {
  equivalentesIniciais: CfopEquivalenteSalvo[];
  podeConfigurar: boolean;
  textos: Textos;
}) {
  const t = useT();
  const tagIdioma = useTagDeIdioma();
  const router = useRouter();
  const [cfopOrigem, setCfopOrigem] = React.useState("");
  const [cfopDestino, setCfopDestino] = React.useState("");
  const [editandoEq, setEditandoEq] = React.useState<CfopEquivalenteSalvo | null>(null);
  const [salvandoEq, setSalvandoEq] = React.useState(false);
  const [jobs, setJobs] = React.useState<JobFiscal[] | null>(null);
  const [spedAno, setSpedAno] = React.useState(String(new Date().getFullYear()));
  const [spedMes, setSpedMes] = React.useState(String(new Date().getMonth() + 1));
  const [spedResumo, setSpedResumo] = React.useState<SpedResumo | null>(null);
  const [gerandoSped, setGerandoSped] = React.useState(false);

  async function salvarEquivalencia() {
    if (!/^\d{4}$/.test(cfopOrigem.trim()) || !/^\d{4}$/.test(cfopDestino.trim())) {
      toast.error(t("CFOP padrão"));
      return;
    }
    setSalvandoEq(true);
    try {
      if (editandoEq) {
        await apiClient.put(`/api/v1/fiscal-cfop-equivalentes/${editandoEq.id}`, {
          cfop_origem: cfopOrigem.trim(),
          cfop_destino: cfopDestino.trim(),
        });
      } else {
        await apiClient.post("/api/v1/fiscal-cfop-equivalentes", {
          cfop_origem: cfopOrigem.trim(),
          cfop_destino: cfopDestino.trim(),
        });
      }
      toast.success(t("Configuração salva"));
      setCfopOrigem("");
      setCfopDestino("");
      setEditandoEq(null);
      router.refresh();
    } catch (e) {
      showApiError(e);
    } finally {
      setSalvandoEq(false);
    }
  }

  async function apagarEquivalencia(id: string) {
    try {
      await apiClient.delete(`/api/v1/fiscal-cfop-equivalentes/${id}`);
      router.refresh();
    } catch (e) {
      showApiError(e);
    }
  }

  async function carregarJobs() {
    try {
      const r = await apiClient.get<{ data: JobFiscal[] }>("/api/v1/fiscal-jobs?abertas=1");
      setJobs(r.data);
    } catch (e) {
      showApiError(e);
    }
  }

  async function gerarSped() {
    setGerandoSped(true);
    setSpedResumo(null);
    try {
      const r = await apiClient.get<{ data: SpedResumo }>(
        `/api/v1/sped/arquivo?ano=${encodeURIComponent(spedAno)}&mes=${encodeURIComponent(spedMes)}`,
      );
      setSpedResumo(r.data);
    } catch (e) {
      showApiError(e);
    } finally {
      setGerandoSped(false);
    }
  }

  function baixarSped() {
    if (!spedResumo) return;
    const blob = new Blob([spedResumo.arquivo], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = spedResumo.nomes.sugestao;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="space-y-5">
      <Card className="space-y-3 p-4 sm:p-5">
        <h2 className="text-base font-medium text-text">
          <span className="mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-muted text-xs text-muted-foreground">
            1
          </span>
          {textos.cfopsEq}
        </h2>
        {equivalentesIniciais.length === 0 ? (
          <p className="text-sm text-muted-foreground">{textos.nenhumaEquiv}</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-surface">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead>{textos.origem}</TableHead>
                  <TableHead>{textos.destino}</TableHead>
                  {podeConfigurar && (
                    <TableHead>
                      <span className="sr-only">{textos.acoes}</span>
                    </TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {equivalentesIniciais.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="font-mono">{e.cfop_origem}</TableCell>
                    <TableCell className="font-mono">{e.cfop_destino}</TableCell>
                    {podeConfigurar && (
                      <TableCell>
                        <div className="flex justify-end gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={textos.editar}
                            title={textos.editar}
                            onClick={() => {
                              setEditandoEq(e);
                              setCfopOrigem(e.cfop_origem);
                              setCfopDestino(e.cfop_destino);
                            }}
                          >
                            <PencilSimple size={14} />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={textos.apagar}
                            title={textos.apagar}
                            onClick={() => void apagarEquivalencia(e.id)}
                          >
                            <Trash size={14} />
                          </Button>
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {podeConfigurar && (
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-28 space-y-1.5">
              <Label htmlFor="eq-origem">{textos.origem}</Label>
              <Input
                id="eq-origem"
                value={cfopOrigem}
                onChange={(e) => setCfopOrigem(e.target.value)}
                maxLength={4}
                inputMode="numeric"
                placeholder="5102"
              />
            </div>
            <div className="w-28 space-y-1.5">
              <Label htmlFor="eq-destino">{textos.destino}</Label>
              <Input
                id="eq-destino"
                value={cfopDestino}
                onChange={(e) => setCfopDestino(e.target.value)}
                maxLength={4}
                inputMode="numeric"
                placeholder="5101"
              />
            </div>
            <Button onClick={() => void salvarEquivalencia()} disabled={salvandoEq}>
              {salvandoEq ? t("Salvando…") : editandoEq ? textos.salvar : textos.novaEquiv}
            </Button>
            {editandoEq && (
              <Button
                variant="outline"
                onClick={() => {
                  setEditandoEq(null);
                  setCfopOrigem("");
                  setCfopDestino("");
                }}
              >
                {textos.cancelarBtn}
              </Button>
            )}
          </div>
        )}
      </Card>

      {podeConfigurar && (
        <Card className="space-y-3 p-4 sm:p-5">
          <h2 className="text-base font-medium text-text">
            <span className="mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-muted text-xs text-muted-foreground">
              2
            </span>
            {textos.gerarArquivo}
          </h2>
          <p className="rounded-lg border border-warning/40 bg-warning-bg p-3 text-xs text-warning-fg">
            {textos.rascunhoPva}
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-24 space-y-1.5">
              <Label htmlFor="sped-ano">{textos.ano}</Label>
              <Input
                id="sped-ano"
                value={spedAno}
                onChange={(e) => setSpedAno(e.target.value)}
                inputMode="numeric"
                maxLength={4}
              />
            </div>
            <div className="w-32 space-y-1.5">
              <Label htmlFor="sped-mes">{textos.mes}</Label>
              <select
                id="sped-mes"
                className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm"
                value={spedMes}
                onChange={(e) => setSpedMes(e.target.value)}
              >
                {Array.from({ length: 12 }, (_, i) => (
                  <option key={i + 1} value={String(i + 1)}>
                    {i + 1}
                  </option>
                ))}
              </select>
            </div>
            <Button onClick={() => void gerarSped()} disabled={gerandoSped}>
              {gerandoSped ? t("Enviando…") : textos.gerarArquivo}
            </Button>
          </div>
          {spedResumo && (
            <div className="space-y-2 rounded-lg border border-border p-3 text-sm">
              <p className="tabular-nums">
                {spedResumo.notas} {textos.notas} · {spedResumo.itens} {textos.itensLabel} ·{" "}
                {spedResumo.linhas} {textos.linhasLabel}
              </p>
              <div>
                <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  {textos.oQueFalta}
                </p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
                  {spedResumo.pendencias.map((p, i) => (
                    <li key={i}>{p}</li>
                  ))}
                </ul>
              </div>
              <Button size="sm" variant="outline" onClick={baixarSped}>
                <DownloadSimple size={14} />
                {textos.baixarArquivo}
              </Button>
            </div>
          )}
        </Card>
      )}

      <Card className="space-y-3 p-4 sm:p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-base font-medium text-text">
            <span className="mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-muted text-xs text-muted-foreground">
              3
            </span>
            {textos.manutencao}
          </h2>
          <Button size="sm" variant="outline" onClick={() => void carregarJobs()}>
            {textos.fila}
          </Button>
        </div>
        {jobs === null ? (
          <p className="text-xs text-muted-foreground">—</p>
        ) : jobs.length === 0 ? (
          <p className="text-sm text-muted-foreground">{textos.filaVazia}</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-surface">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead>{textos.numNota}</TableHead>
                  <TableHead>{textos.status}</TableHead>
                  <TableHead>{textos.tentativa}</TableHead>
                  <TableHead>{textos.proxTentativa}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {jobs.map((j) => (
                  <TableRow key={j.id}>
                    <TableCell className="tabular-nums">
                      {j.nota?.numero === null || j.nota?.numero === undefined
                        ? textos.semNumero
                        : `${j.nota.numero}/${j.nota.serie}`}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          j.status === "erro"
                            ? "error"
                            : j.status === "concluido"
                              ? "success"
                              : "info"
                        }
                      >
                        {j.status === "processando"
                          ? textos.processando
                          : j.status === "concluido"
                            ? textos.concluido
                            : j.status === "erro"
                              ? textos.erro
                              : textos.pendente}
                      </Badge>
                      {j.ultimo_erro && (
                        <span className="block text-xs text-error-fg">{j.ultimo_erro}</span>
                      )}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {j.tentativas}/{j.max_tentativas}
                    </TableCell>
                    <TableCell className="text-xs whitespace-nowrap text-muted-foreground">
                      {new Date(j.proxima_tentativa).toLocaleString(tagIdioma)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>
    </div>
  );
}
