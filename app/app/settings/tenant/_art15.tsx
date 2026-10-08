"use client";
/**
 * As ALÍNEAS do art. 15.º que o controlador preenche (#2356): o cartão de
 * `organizations.settings.art15` em Configurações › Empresa.
 *
 * Sem ele, o #2354 é meia porta: o PDF de acesso de Portugal já SABE ler as
 * alíneas a), c) e d), mas ninguém consegue escrevê-las pelo produto — hoje só
 * um `UPDATE` em SQL preenche, e toda organização PT recebe "não informado
 * pelo controlador". A gravação é `PATCH /api/v1/settings/art15` (admin), com o
 * MESMO `art15SettingsSchema` da leitura: os limites 2000/2000/500 moram num
 * lugar só, e a `maxLength` daqui é só o aviso antes do 422 do servidor.
 *
 * Só fora do Brasil (`alineasDoArt15Visiveis`, em `lib/legal/art15.ts`): o
 * art. 15.º é do RGPD, e o documento brasileiro (LGPD) não tem esta seção —
 * esconder o cartão onde ele não seria lido é o mesmo corte que o PDF já faz
 * (`lib/lgpd/pdf-renderer.tsx` só renderiza `art15` quando o coletor emitiu).
 */
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { art15SettingsSchema, type Art15Settings } from "@/lib/legal/art15";

/** O que a tela pede: string sempre, `null` virando "" na entrada. */
export type AlineasPreenchidas = {
  finalidades: string;
  destinatarios: string;
  prazo_conservacao: string;
};

export function Art15Form({ initial }: { initial: AlineasPreenchidas }) {
  const t = useT();
  const [form, setForm] = useState<AlineasPreenchidas>(initial);
  const [salvo, setSalvo] = useState<AlineasPreenchidas>(initial);
  const [isPending, startTransition] = useTransition();
  const sujo = JSON.stringify(form) !== JSON.stringify(salvo);

  const campos: Array<{
    chave: keyof AlineasPreenchidas;
    rotulo: string;
    ajuda: string;
    max: number;
  }> = [
    {
      chave: "finalidades",
      rotulo: t("Finalidades do tratamento (alínea a))"),
      ajuda: t("Para que fins os dados pessoais são tratados: atendimento, faturação, marketing."),
      max: 2000,
    },
    {
      chave: "destinatarios",
      rotulo: t("Destinatários dos dados (alínea c))"),
      ajuda: t("Com quem esses dados são compartilhados: prestadores, autoridades, parceiros."),
      max: 2000,
    },
    {
      chave: "prazo_conservacao",
      rotulo: t("Prazo de conservação dos dados (alínea d))"),
      ajuda: t("Por quanto tempo os dados são guardados depois do último contato."),
      max: 500,
    },
  ];

  function salvar(e: React.FormEvent) {
    e.preventDefault();
    const corpo: Art15Settings = {
      finalidades: form.finalidades,
      destinatarios: form.destinatarios,
      prazo_conservacao: form.prazo_conservacao,
    };
    if (!art15SettingsSchema.safeParse(corpo).success) {
      toast.error(t("Dados inválidos."));
      return;
    }
    startTransition(async () => {
      try {
        await apiClient.patch("/api/v1/settings/art15", corpo);
        setSalvo(form);
        toast.success(t("Alíneas do art. 15.º salvas."));
      } catch (err) {
        toast.error(err instanceof Error ? t(err.message) : t("Não consegui salvar."));
      }
    });
  }

  return (
    <form onSubmit={salvar} className="max-w-2xl" data-testid="form-art15">
      <Card className="space-y-4 p-6">
        <div>
          <h2 className="text-sm font-semibold">{t("Alíneas do art. 15.º do RGPD")}</h2>
          <p className="text-xs text-muted-foreground">
            {t(
              "O relatório de acesso imprime estes três textos em nome da organização. Deixar em branco faz o documento mostrar «não informado pelo controlador» — nada é inventado no lugar do que falta.",
            )}
          </p>
        </div>
        {campos.map((campo) => (
          <div key={campo.chave} className="space-y-2">
            <Label htmlFor={`art15-${campo.chave}`}>{campo.rotulo}</Label>
            <Textarea
              id={`art15-${campo.chave}`}
              data-testid={`art15-${campo.chave}`}
              value={form[campo.chave]}
              maxLength={campo.max}
              disabled={isPending}
              rows={campo.chave === "prazo_conservacao" ? 2 : 4}
              onChange={(e) => setForm((f) => ({ ...f, [campo.chave]: e.target.value }))}
            />
            <p className="text-xs text-muted-foreground">
              {campo.ajuda} {t("Máximo de {n} caracteres.").replace("{n}", String(campo.max))}
            </p>
          </div>
        ))}
        <div className="flex items-center gap-3 sm:justify-end">
          <Button type="submit" disabled={isPending || !sujo}>
            {isPending ? t("Salvando…") : t("Salvar alíneas")}
          </Button>
          {sujo ? <span className="text-xs text-muted-foreground">{t("Há mudanças não salvas.")}</span> : null}
        </div>
      </Card>
    </form>
  );
}
