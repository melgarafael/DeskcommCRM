"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiClient } from "@/lib/api/client";
import type { ConfigFiscalSalva } from "@/lib/schemas/fiscal";

import type { Textos } from "./textos";

/**
 * Aba "Configuração" — os dados do emitente em seções (emitente, endereço,
 * emissão/SEFAZ, certificado), como a ficha cadastral dos ERPs. Uma tela só
 * para isso: série/CFOP errado contamina todas as notas.
 */
export function ConfigFiscal({
  configInicial,
  textos,
}: {
  configInicial: ConfigFiscalSalva | null;
  textos: Textos;
}) {
  const t = useT();
  const router = useRouter();
  const [serie, setSerie] = React.useState(configInicial?.serie ?? "1");
  const [natureza, setNatureza] = React.useState(
    configInicial?.natureza_operacao ?? "Venda de mercadoria",
  );
  const [cfop, setCfop] = React.useState(configInicial?.cfop_padrao ?? "5102");
  const [documento, setDocumento] = React.useState(configInicial?.emitente_documento ?? "");
  const [ie, setIe] = React.useState(configInicial?.ie ?? "");
  const [crt, setCrt] = React.useState(configInicial?.crt ?? "1");
  const [logradouro, setLogradouro] = React.useState(configInicial?.logradouro ?? "");
  const [numeroEnd, setNumeroEnd] = React.useState(configInicial?.numero_end ?? "");
  const [bairro, setBairro] = React.useState(configInicial?.bairro ?? "");
  const [municipio, setMunicipio] = React.useState(configInicial?.municipio ?? "");
  const [codMun, setCodMun] = React.useState(configInicial?.codigo_municipio ?? "");
  const [uf, setUf] = React.useState(configInicial?.uf ?? "");
  const [cep, setCep] = React.useState(configInicial?.cep ?? "");
  const [ambiente, setAmbiente] = React.useState(configInicial?.ambiente ?? "homologacao");
  const [provedor, setProvedor] = React.useState(configInicial?.provedor ?? "stub");
  const [certPath, setCertPath] = React.useState(configInicial?.certificado_path ?? "");
  const [certSenha, setCertSenha] = React.useState("");
  const [salvandoConfig, setSalvandoConfig] = React.useState(false);

  async function salvarConfig() {
    setSalvandoConfig(true);
    try {
      await apiClient.put("/api/v1/fiscal-settings", {
        serie: serie.trim() || "1",
        natureza_operacao: natureza.trim() || "Venda de mercadoria",
        cfop_padrao: cfop.trim() || "5102",
        emitente_documento: documento.trim() === "" ? null : documento.trim(),
        ie: ie.trim() === "" ? null : ie.trim(),
        crt,
        logradouro: logradouro.trim() === "" ? null : logradouro.trim(),
        numero_end: numeroEnd.trim() === "" ? null : numeroEnd.trim(),
        bairro: bairro.trim() === "" ? null : bairro.trim(),
        municipio: municipio.trim() === "" ? null : municipio.trim(),
        codigo_municipio: codMun.trim() === "" ? null : codMun.trim(),
        uf: uf.trim() === "" ? null : uf.trim().toUpperCase(),
        cep: cep.trim() === "" ? null : cep.trim(),
        ambiente,
        provedor,
        certificado_path: certPath.trim() === "" ? null : certPath.trim(),
        ...(certSenha !== "" ? { certificado_senha: certSenha } : {}),
      });
      toast.success(t("Configuração salva"));
      setCertSenha("");
      router.refresh();
    } catch (e) {
      showApiError(e);
    } finally {
      setSalvandoConfig(false);
    }
  }

  return (
    <Card className="space-y-5 p-4 sm:p-5">
      <div className="flex items-center gap-2">
        <h2 className="text-base font-medium text-text">{textos.config}</h2>
        {ambiente === "homologacao" && <Badge variant="warning">{textos.homologacao}</Badge>}
      </div>

      {ambiente === "homologacao" && (
        <p className="rounded-lg border border-warning/40 bg-warning-bg p-3 text-sm text-warning-fg">
          {textos.avisoHomologacao}
        </p>
      )}

      <fieldset className="space-y-3">
        <legend className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {textos.emitente}
        </legend>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="serie">{textos.serie}</Label>
            <Input id="serie" value={serie} onChange={(e) => setSerie(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="crt">CRT</Label>
            <select
              id="crt"
              className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm"
              value={crt}
              onChange={(e) => setCrt(e.target.value)}
            >
              <option value="1">1 — Simples Nacional</option>
              <option value="2">2 — Simples, excesso</option>
              <option value="3">3 — Regime normal</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="doc">{textos.documento}</Label>
            <Input id="doc" value={documento} onChange={(e) => setDocumento(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ie">IE</Label>
            <Input id="ie" value={ie} onChange={(e) => setIe(e.target.value)} />
          </div>
        </div>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {textos.enderecoEmitente}
        </legend>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="logradouro">{textos.logradouro}</Label>
            <Input id="logradouro" value={logradouro} onChange={(e) => setLogradouro(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="numero-end">{textos.numeroEnd}</Label>
            <Input id="numero-end" value={numeroEnd} onChange={(e) => setNumeroEnd(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bairro">{textos.bairro}</Label>
            <Input id="bairro" value={bairro} onChange={(e) => setBairro(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="municipio">{textos.municipio}</Label>
            <Input id="municipio" value={municipio} onChange={(e) => setMunicipio(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="codmun">{textos.codMun}</Label>
            <Input id="codmun" value={codMun} onChange={(e) => setCodMun(e.target.value)} placeholder="3550308" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="uf">UF</Label>
              <Input id="uf" value={uf} onChange={(e) => setUf(e.target.value)} maxLength={2} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cep">CEP</Label>
              <Input id="cep" value={cep} onChange={(e) => setCep(e.target.value)} />
            </div>
          </div>
        </div>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {textos.emissaoSefaz}
        </legend>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="natureza">{textos.natureza}</Label>
            <Input id="natureza" value={natureza} onChange={(e) => setNatureza(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cfop">{textos.cfop}</Label>
            <Input id="cfop" value={cfop} onChange={(e) => setCfop(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ambiente">{textos.ambiente}</Label>
            <select
              id="ambiente"
              className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm"
              value={ambiente}
              onChange={(e) => setAmbiente(e.target.value)}
            >
              <option value="homologacao">{textos.homologacao}</option>
              <option value="producao">{textos.producao}</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="provedor">{textos.provedorFiscal}</Label>
            <select
              id="provedor"
              className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm"
              value={provedor}
              onChange={(e) => setProvedor(e.target.value)}
            >
              <option value="stub">{textos.provedorStub}</option>
              <option value="spednfe">{textos.provedorSped}</option>
            </select>
          </div>
        </div>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {textos.certificado}
        </legend>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="cert-path">{textos.certPath}</Label>
            <Input
              id="cert-path"
              value={certPath}
              onChange={(e) => setCertPath(e.target.value)}
              placeholder="/certs/empresa.pfx"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cert-senha">{textos.certSenha}</Label>
            <Input
              id="cert-senha"
              type="password"
              value={certSenha}
              onChange={(e) => setCertSenha(e.target.value)}
              placeholder={textos.certSenhaVazia}
              autoComplete="off"
            />
          </div>
        </div>
      </fieldset>

      <div className="flex justify-end">
        <Button onClick={() => void salvarConfig()} disabled={salvandoConfig}>
          {salvandoConfig ? t("Salvando…") : textos.salvarConfig}
        </Button>
      </div>
    </Card>
  );
}
