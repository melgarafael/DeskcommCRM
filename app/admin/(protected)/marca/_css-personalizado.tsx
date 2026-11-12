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

const EXEMPLO_CLARO = `.text-muted-foreground {\n  color: #52645a;\n}\n\n.rounded-md {\n  border-radius: 12px;\n}`;
const EXEMPLO_ESCURO = `.nav-grupo-crm .rounded-md:hover {\n  background-color: #1f3a2b;\n}\n\n.card {\n  background-color: #10261a;\n}`;

/**
 * O editor das DUAS folhas de CSS personalizado (#4463).
 *
 * São dois campos porque o problema tem duas metades: uma cor fixa que fica boa
 * no claro fica ilegível no escuro, e até aqui não havia como escrever uma regra
 * só para o escuro. O campo do escuro é prefixado com
 * `:root:root[data-theme="dark"]` no servidor, então o texto que o cliente
 * escreve continua sendo só seletor de classe.
 */
export function CssPersonalizado({
  gravado,
  gravadoEscuro,
  erroAtual,
  erroAtualEscuro,
}: {
  gravado: string;
  gravadoEscuro: string;
  erroAtual: string | null;
  erroAtualEscuro: string | null;
}) {
  const t = useT();
  const router = useRouter();
  const [css, setCss] = useState(gravado);
  const [cssEscuro, setCssEscuro] = useState(gravadoEscuro);
  const [isPending, startTransition] = useTransition();

  function salvar(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startTransition(async () => {
      const resultado = await updateCustomBrandingCss({ claro: css, escuro: cssEscuro });
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

        <div className="space-y-2">
          <Label htmlFor="custom_css">{t("CSS dos dois temas")}</Label>
          <p className="text-xs text-text-muted">
            {t(
              "Estas regras valem nos dois temas. As do tema escuro vencem quando ele está ativo.",
            )}
          </p>
          {erroAtual ? (
            <p
              role="alert"
              className="rounded-md border border-error/30 bg-error/10 p-3 text-sm text-error-fg"
            >
              {t("O CSS salvo não foi aplicado porque contém uma regra inválida.")} {erroAtual}
            </p>
          ) : null}
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

        <div className="space-y-2">
          <Label htmlFor="custom_css_escuro">{t("CSS do tema escuro")}</Label>
          <p className="text-xs text-text-muted">
            {t("Estas regras valem só quando o tema escuro está ativo.")}
          </p>
          {erroAtualEscuro ? (
            <p
              role="alert"
              className="rounded-md border border-error/30 bg-error/10 p-3 text-sm text-error-fg"
            >
              {t("O CSS salvo não foi aplicado porque contém uma regra inválida.")}{" "}
              {erroAtualEscuro}
            </p>
          ) : null}
          <Textarea
            id="custom_css_escuro"
            value={cssEscuro}
            onChange={(evento) => setCssEscuro(evento.target.value)}
            rows={8}
            maxLength={16_384}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            className="font-mono text-xs"
            aria-describedby="custom-css-escuro-ajuda"
          />
          <p id="custom-css-escuro-ajuda" className="text-xs text-text-muted">
            {t("Mesmas regras de seletor e propriedades do campo acima.")}
          </p>
        </div>

        <details className="text-sm">
          <summary className="cursor-pointer font-medium">{t("Ver exemplo")}</summary>
          <pre className="mt-2 overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">
            {EXEMPLO_CLARO}
          </pre>
          <pre className="mt-2 overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">
            {EXEMPLO_ESCURO}
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
