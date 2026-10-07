"use client";
/**
 * Assinatura do emissor (#2066): a porta de `settings.assinatura_mensagens`.
 * Sem este cartão o recurso só ligava por SQL. A regra mora em
 * `lib/messaging/assinatura.ts`; a gravação, em `/api/v1/settings/assinatura`.
 */
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";

export interface AssinaturaConfig {
  humanos: boolean;
  ia: boolean;
  nome_ia: string;
}

export function AssinaturaForm({ initial }: { initial: AssinaturaConfig }) {
  const t = useT();
  const [form, setForm] = useState(initial);
  const [salvo, setSalvo] = useState(initial);
  const [isPending, startTransition] = useTransition();
  const sujo = JSON.stringify(form) !== JSON.stringify(salvo);

  function salvar(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      try {
        await apiClient.patch("/api/v1/settings/assinatura", form);
        setSalvo(form);
        toast.success(t("Assinatura salva."));
      } catch (err) {
        toast.error(err instanceof Error ? t(err.message) : t("Não consegui salvar."));
      }
    });
  }

  const opcoes = [
    {
      chave: "humanos" as const,
      titulo: "Assinar as mensagens dos atendentes",
      corpo: "Cada atendente aparece pelo próprio nome, com as iniciais em maiúscula.",
    },
    {
      chave: "ia" as const,
      titulo: "Assinar as mensagens da IA",
      corpo: "A IA aparece pelo nome abaixo, nunca pelo nome de um atendente.",
    },
  ];

  return (
    <form onSubmit={salvar} className="flex max-w-3xl flex-col gap-4" data-testid="form-assinatura">
      <Card className="space-y-4 p-4">
        <div>
          <h2 className="text-sm font-semibold">{t("Quem fala aparece na mensagem?")}</h2>
          <p className="text-xs text-muted-foreground">
            {t(
              "Ligado, a mensagem que vai ao cliente ganha o nome de quem fala em negrito, na linha de cima. O histórico do CRM guarda o texto como foi escrito. Campanhas, lembretes e integrações por token não assinam.",
            )}
          </p>
        </div>
        {opcoes.map((o) => (
          <label key={o.chave} className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              data-testid={`assinatura-${o.chave}`}
              checked={form[o.chave]}
              disabled={isPending}
              onChange={(e) => setForm((f) => ({ ...f, [o.chave]: e.target.checked }))}
              className="mt-1 h-4 w-4 shrink-0 accent-primary"
            />
            <span className="space-y-1">
              <span className="block text-sm font-medium">{t(o.titulo)}</span>
              <span className="block text-xs text-muted-foreground">{t(o.corpo)}</span>
            </span>
          </label>
        ))}
        <div className="max-w-sm space-y-1">
          <Label htmlFor="assinatura-nome-ia">{t("Nome da IA")}</Label>
          <Input
            id="assinatura-nome-ia"
            value={form.nome_ia}
            maxLength={120}
            disabled={isPending}
            onChange={(e) => setForm((f) => ({ ...f, nome_ia: e.target.value }))}
          />
          <p className="text-xs text-muted-foreground">{t("Sem asteriscos nem quebra de linha.")}</p>
        </div>
      </Card>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={isPending || !sujo}>
          {isPending ? t("Salvando…") : t("Salvar assinatura")}
        </Button>
        {sujo ? <span className="text-xs text-muted-foreground">{t("Há mudanças não salvas.")}</span> : null}
      </div>
    </form>
  );
}
