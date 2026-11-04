"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { configuracaoAgenciaSchema, type ConfiguracaoAgencia } from "@/lib/agencias/schema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function CardDeAgencia({
  organizationId,
  inicial,
  utilizadas,
  podeEditar,
}: {
  organizationId: string;
  inicial: ConfiguracaoAgencia;
  utilizadas: number;
  podeEditar: boolean;
}) {
  const t = useT();
  const router = useRouter();
  const [habilitada, setHabilitada] = useState(inicial.habilitada);
  const [limite, setLimite] = useState(String(inicial.limite_clientes));
  const [inclusos, setInclusos] = useState(inicial.clientes_inclusos ?? false);
  const [salvando, setSalvando] = useState(false);
  const [mensagem, setMensagem] = useState("");
  async function salvar(event: FormEvent) {
    event.preventDefault();
    const parsed = configuracaoAgenciaSchema.safeParse({
      habilitada,
      clientes_inclusos: inclusos,
      limite_clientes: limite.trim() ? Number(limite) : NaN,
    });
    if (!parsed.success) {
      setMensagem(t("Informe um limite inteiro entre 0 e 10000."));
      return;
    }
    setSalvando(true);
    setMensagem("");
    try {
      await apiClient.patch(`/api/v1/admin/tenants/${organizationId}/agencia`, parsed.data);
      setMensagem(t("Configuração de agência salva."));
      router.refresh();
    } catch {
      setMensagem(t("Não foi possível salvar a configuração de agência."));
    } finally {
      setSalvando(false);
    }
  }
  return (
    <form onSubmit={salvar} className="space-y-4 rounded-lg border p-6">
      <h2 className="text-lg font-semibold">{t("Gestão de organizações clientes")}</h2>
      <p className="text-sm text-muted-foreground">
        {t("Organizações vinculadas")}: {utilizadas}
      </p>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={habilitada}
          disabled={!podeEditar || salvando}
          onChange={(e) => setHabilitada(e.target.checked)}
        />
        {t("Permitir que esta agência administre organizações clientes")}
      </label>
      <label className="block space-y-2">
        <span>{t("Limite de organizações clientes")}</span>
        <Input
          type="number"
          min={0}
          max={10000}
          step={1}
          value={limite}
          disabled={!podeEditar || salvando}
          onChange={(e) => setLimite(e.target.value)}
        />
      </label>
      <p className="text-sm text-muted-foreground">
        {t(
          "Reduzir o limite preserva os clientes existentes. Organizações suspensas continuam contando.",
        )}
      </p>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={inclusos}
          disabled={!podeEditar || salvando}
          onChange={(e) => setInclusos(e.target.checked)}
        />
        {t("Incluir clientes no acordo comercial da agência")}
      </label>
      <p className="text-sm text-muted-foreground">
        {t(
          "Autoriza criar clientes sem assinatura individual, mesmo com cobrança ativa. Valores e porcentagens são negociados separadamente; não há cobrança automática por cliente.",
        )}
      </p>
      <Button type="submit" disabled={!podeEditar || salvando}>
        {t("Salvar")}
      </Button>
      <p role="status" aria-live="polite">
        {mensagem}
      </p>
    </form>
  );
}
