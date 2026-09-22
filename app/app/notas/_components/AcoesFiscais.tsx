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
import type { ConfigFiscalSalva, InutilizacaoSalva } from "@/lib/schemas/fiscal";
import { FileText } from "@/lib/ui/icons";

import type { Textos } from "./textos";

/**
 * Aba "Ações fiscais" — o menu Emissor do Odivix: inutilizar numeração,
 * lista de inutilizadas e IBPT. A carta de correção mora na grade, junto da
 * nota autorizada que ela corrige (é lá que o usuário está quando precisa).
 */
export function AcoesFiscais({
  configInicial,
  inutilizacoesIniciais,
  textos,
}: {
  configInicial: ConfigFiscalSalva | null;
  inutilizacoesIniciais: InutilizacaoSalva[];
  textos: Textos;
}) {
  const t = useT();
  const tagIdioma = useTagDeIdioma();
  const router = useRouter();
  const [serieInut, setSerieInut] = React.useState(configInicial?.serie ?? "1");
  const [numIni, setNumIni] = React.useState("");
  const [numFim, setNumFim] = React.useState("");
  const [motivoInut, setMotivoInut] = React.useState("");
  const [inutilizando, setInutilizando] = React.useState(false);

  async function inutilizarFaixa() {
    const ini = Number(numIni);
    const fim = Number(numFim);
    if (!Number.isInteger(ini) || ini <= 0 || !Number.isInteger(fim) || fim < ini) {
      toast.error(textos.faixa);
      return;
    }
    if (motivoInut.trim().length < 15 || motivoInut.trim().length > 255) {
      toast.error(textos.dicaMotivo);
      return;
    }
    setInutilizando(true);
    try {
      await apiClient.post("/api/v1/fiscal-inutilizacoes", {
        serie: serieInut.trim() || "1",
        numero_inicial: ini,
        numero_final: fim,
        motivo: motivoInut.trim(),
      });
      toast.success(`${textos.inutilizarNum} — ${textos.registradaLocal}`);
      setNumIni("");
      setNumFim("");
      setMotivoInut("");
      router.refresh();
    } catch (e) {
      showApiError(e);
    } finally {
      setInutilizando(false);
    }
  }

  return (
    <div className="space-y-5">
      <Card className="space-y-3 p-4 sm:p-5">
        <h2 className="flex items-center gap-2 text-base font-medium text-text">
          <FileText size={18} className="text-muted-foreground" />
          {textos.inutilizarNum}
        </h2>
        <p className="text-xs text-muted-foreground">{textos.registradaLocal}</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="space-y-1.5">
            <Label htmlFor="inut-serie">{textos.serie}</Label>
            <Input
              id="inut-serie"
              value={serieInut}
              onChange={(e) => setSerieInut(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="inut-ini">{textos.numInicial}</Label>
            <Input
              id="inut-ini"
              inputMode="numeric"
              value={numIni}
              onChange={(e) => setNumIni(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="inut-fim">{textos.numFinal}</Label>
            <Input
              id="inut-fim"
              inputMode="numeric"
              value={numFim}
              onChange={(e) => setNumFim(e.target.value)}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-1">
            <Label htmlFor="inut-motivo">{textos.motivoSimples}</Label>
            <Input
              id="inut-motivo"
              value={motivoInut}
              onChange={(e) => setMotivoInut(e.target.value)}
              placeholder={textos.dicaMotivo}
            />
          </div>
        </div>
        <div className="flex justify-end">
          <Button onClick={() => void inutilizarFaixa()} disabled={inutilizando}>
            {inutilizando ? t("Enviando…") : textos.inutilizarFaixa}
          </Button>
        </div>
      </Card>

      <Card className="space-y-2 p-4 sm:p-5">
        <h2 className="text-base font-medium text-text">{textos.notasInutilizadas}</h2>
        {inutilizacoesIniciais.length === 0 ? (
          <p className="text-sm text-muted-foreground">{textos.nenhumaInutilizacao}</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-surface">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead>{textos.serie}</TableHead>
                  <TableHead>{textos.faixa}</TableHead>
                  <TableHead>{textos.motivoSimples}</TableHead>
                  <TableHead>{textos.status}</TableHead>
                  <TableHead>{textos.data}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {inutilizacoesIniciais.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell>{u.serie}</TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">
                      {u.numero_inicial}–{u.numero_final}
                    </TableCell>
                    <TableCell className="max-w-72 truncate" title={u.motivo}>
                      {u.motivo}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          u.status === "transmitida"
                            ? "success"
                            : u.status === "erro"
                              ? "error"
                              : "neutral"
                        }
                      >
                        {u.status === "transmitida"
                          ? textos.transmitida
                          : u.status === "erro"
                            ? textos.erro
                            : textos.registrada}
                      </Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {new Date(u.created_at).toLocaleDateString(tagIdioma)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>

      <Card className="space-y-1 p-4 sm:p-5">
        <h2 className="text-base font-medium text-text">{textos.ibpt}</h2>
        <p className="text-sm text-muted-foreground">{textos.semIbpt}</p>
      </Card>
    </div>
  );
}
