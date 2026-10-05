"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { updateCustomBrandingCss } from "@/app/actions/settings/updateCustomBrandingCss";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/hooks/i18n/useT";

const EXEMPLO = `.text-muted-foreground {\n  color: #52645a;\n}\n\n.rounded-md {\n  border-radius: 12px;\n}`;

export function CssPersonalizado({
  gravado,
  erroAtual,
}: {
  gravado: string;
  erroAtual: string | null;
}) {
  const t = useT();
  const router = useRouter();
  const [css, setCss] = useState(gravado);
  const [isPending, startTransition] = useTransition();

  function salvar(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startTransition(async () => {
      const resultado = await updateCustomBrandingCss(css);
      if (resultado.ok) {
        toast.success(t("CSS personalizado salvo."));
        router.refresh();
        return;
      }
      toast.error(t(resultado.error));
    });
  }

  return (
    <form onSubmit={salvar} className="max-w-3xl">
      <Card className="space-y-4 p-6">
        <div className="space-y-1">
          <h2 className="text-base font-semibold">{t("CSS personalizado")}</h2>
          <p className="text-sm text-text-muted">
            {t(
              "Ajustes visuais globais: afetam o login e todas as telas, em todas as organizações desta instalação.",
            )}
          </p>
        </div>

        {erroAtual ? (
          <p
            role="alert"
            className="rounded-md border border-error/30 bg-error/10 p-3 text-sm text-error-fg"
          >
            {t("O CSS salvo não foi aplicado porque contém uma regra inválida.")} {erroAtual}
          </p>
        ) : null}

        <div className="space-y-2">
          <Label htmlFor="custom_css">{t("Regras CSS")}</Label>
          <Textarea
            id="custom_css"
            value={css}
            onChange={(evento) => setCss(evento.target.value)}
            rows={12}
            maxLength={16_384}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            className="font-mono text-xs"
            aria-describedby="custom-css-ajuda"
          />
          <p id="custom-css-ajuda" className="text-xs text-text-muted">
            {t(
              "Use seletores de classe e propriedades visuais (cores, bordas, sombras e tipografia). Sem seletores globais ou por ID, @rules, URLs, scripts, !important ou propriedades de layout e posicionamento. Até 16 KB. Deixe vazio e salve para remover.",
            )}
          </p>
        </div>

        <details className="text-sm">
          <summary className="cursor-pointer font-medium">{t("Ver exemplo")}</summary>
          <pre className="mt-2 overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">
            {EXEMPLO}
          </pre>
        </details>

        <div className="flex justify-end">
          <Button type="submit" disabled={isPending}>
            {isPending ? t("Salvando…") : t("Salvar CSS")}
          </Button>
        </div>
      </Card>
    </form>
  );
}
