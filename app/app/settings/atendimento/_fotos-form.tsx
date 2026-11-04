"use client";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";

export function FotosProgressivasForm({
  initial,
  erroLeitura = false,
}: {
  initial: boolean;
  erroLeitura?: boolean;
}) {
  const t = useT();
  const [habilitado, setHabilitado] = useState(initial);
  const [salvo, setSalvo] = useState(initial);
  const [pending, startTransition] = useTransition();
  function salvar(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      try {
        await apiClient.patch("/api/v1/settings/fotos-progressivas", { habilitado });
        setSalvo(habilitado);
        toast.success(t("Configuração de fotos salva."));
      } catch (err) {
        toast.error(err instanceof Error ? t(err.message) : t("Não consegui salvar."));
      }
    });
  }
  return (
    <form onSubmit={salvar} className="flex max-w-3xl flex-col gap-4">
      <Card className="space-y-3 p-4">
        <h2 className="text-sm font-semibold">{t("Fotos adicionais do catálogo")}</h2>
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={habilitado}
            disabled={pending || erroLeitura}
            onChange={(e) => setHabilitado(e.target.checked)}
            className="mt-1 h-4 w-4 accent-primary"
          />
          <span className="text-sm">
            {t("Permitir que a IA escolha fotos ainda não enviadas nesta conversa")}
          </span>
        </label>
        <p className="text-xs text-muted-foreground">
          {t(
            "Desligado por padrão. Quando ligado, o agente pode pedir fotos inéditas do produto selecionado: uma por padrão, até três por pedido. Não altera os limites de envio nem o atendimento das outras empresas.",
          )}
        </p>
        {erroLeitura && (
          <p role="alert">{t("Não consegui ler a configuração de fotos. Recarregue a página.")}</p>
        )}
      </Card>
      <Button
        type="submit"
        disabled={pending || erroLeitura || habilitado === salvo}
        className="self-start"
      >
        {pending ? t("Salvando…") : t("Salvar configuração de fotos")}
      </Button>
    </form>
  );
}
