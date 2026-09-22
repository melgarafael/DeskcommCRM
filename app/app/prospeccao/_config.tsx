"use client";

import * as React from "react";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiClient } from "@/lib/api/client";
import { METADADOS_PROVIDERS } from "@/lib/prospeccao/providers/registro";

/**
 * Aba CONFIG (§28 do plano) — manager+.
 *
 * A chave NUNCA volta do servidor (só `tem_chave`): o campo de senha nasce
 * vazio sempre, e vazio mantém a atual. Limites, grade e ritmo sem código.
 */
interface Config {
  configurado: boolean;
  tem_chave?: boolean;
  provider_ativo?: string;
  limite_por_busca?: number;
  limite_diario?: number;
  grid_size_km?: number;
  raio_padrao_km?: number;
  concorrencia?: number;
  retries?: number;
  timeout_ms?: number;
  requisicoes_por_minuto?: number;
  cache_ttl_dias?: number;
}

export function ConfigTab() {
  const t = useT();
  const [cfg, setCfg] = React.useState<Config | null>(null);
  const [chave, setChave] = React.useState("");
  const [form, setForm] = React.useState<Record<string, string>>({});
  const [salvando, setSalvando] = React.useState(false);

  const recarregar = React.useCallback(async () => {
    try {
      const corpo = await apiClient.get<{ data: Config | null }>("/api/v1/prospecting/settings");
      const c = corpo?.data;
      if (!c || typeof c !== "object") return;
      setCfg(c);
      setForm({
        provider_ativo: String(c.provider_ativo ?? "google_places"),
        limite_por_busca: String(c.limite_por_busca ?? 500),
        limite_diario: String(c.limite_diario ?? 2000),
        grid_size_km: String(c.grid_size_km ?? 5),
        raio_padrao_km: String(c.raio_padrao_km ?? 30),
        concorrencia: String(c.concorrencia ?? 2),
        retries: String(c.retries ?? 3),
        timeout_ms: String(c.timeout_ms ?? 15000),
        requisicoes_por_minuto: String(c.requisicoes_por_minuto ?? 60),
        cache_ttl_dias: String(c.cache_ttl_dias ?? 30),
      });
    } catch (e) {
      showApiError(e);
    }
  }, []);

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void recarregar();
  }, [recarregar]);

  async function salvar() {
    setSalvando(true);
    try {
      await apiClient.put("/api/v1/prospecting/settings", {
        provider_ativo: form.provider_ativo,
        ...(chave.trim() ? { google_api_key: chave.trim() } : {}),
        limite_por_busca: Number(form.limite_por_busca) || 500,
        limite_diario: Number(form.limite_diario) || 2000,
        grid_size_km: Number(form.grid_size_km) || 5,
        raio_padrao_km: Number(form.raio_padrao_km) || 30,
        concorrencia: Number(form.concorrencia) || 2,
        retries: Number(form.retries ?? 3),
        timeout_ms: Number(form.timeout_ms) || 15000,
        requisicoes_por_minuto: Number(form.requisicoes_por_minuto) || 60,
        cache_ttl_dias: Number(form.cache_ttl_dias ?? 30),
      });
      toast.success(t("Configuração salva"));
      setChave("");
      await recarregar();
    } catch (e) {
      showApiError(e);
    } finally {
      setSalvando(false);
    }
  }

  if (!cfg) {
    return <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>;
  }

  const campo = (id: string, rotulo: string, tipo = "text") => (
    <div className="space-y-1.5" key={id}>
      <Label htmlFor={`cfg-${id}`}>{rotulo}</Label>
      <Input
        id={`cfg-${id}`}
        type={tipo}
        value={form[id] ?? ""}
        onChange={(e) => setForm((f) => ({ ...f, [id]: e.target.value }))}
      />
    </div>
  );

  return (
    <Card className="space-y-4 p-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="cfg-provider">{t("Provider ativo")}</Label>
          <select
            id="cfg-provider"
            className="rounded-lg border bg-background px-3 py-2 text-sm"
            value={form.provider_ativo}
            onChange={(e) => setForm((f) => ({ ...f, provider_ativo: e.target.value }))}
          >
            {METADADOS_PROVIDERS.map((p) => (
              <option key={p.nome} value={p.nome}>
                {p.rotulo}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="cfg-chave">
            {t("Chave do Google")} {cfg.tem_chave ? `(${t("cadastrada")})` : `(${t("ausente")})`}
          </Label>
          <Input
            id="cfg-chave"
            type="password"
            value={chave}
            onChange={(e) => setChave(e.target.value)}
            placeholder={t("Vazio = mantém a atual")}
            autoComplete="off"
          />
        </div>
        {campo("limite_por_busca", t("Limite por busca"), "number")}
        {campo("limite_diario", t("Limite diário (requisições)"), "number")}
        {campo("grid_size_km", t("Grade (km por célula)"), "number")}
        {campo("raio_padrao_km", t("Raio padrão (km)"), "number")}
        {campo("requisicoes_por_minuto", t("Requisições por minuto"), "number")}
        {campo("cache_ttl_dias", t("Cache (dias, 0 desliga)"), "number")}
      </div>
      <Button onClick={salvar} disabled={salvando}>
        {t(salvando ? "Salvando…" : "Salvar configuração")}
      </Button>
    </Card>
  );
}
