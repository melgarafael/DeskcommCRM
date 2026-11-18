"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { updatePlatformTheme } from "@/app/actions/settings/updatePlatformTheme";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT } from "@/hooks/i18n/useT";

/** O valor do seletor para "nenhum tema" — nunca um id, que sempre é uuid. */
const NENHUM = "nenhum";

export type TemaOferecido = {
  readonly instalacaoId: string;
  readonly rotulo: string;
  readonly versao: string;
  readonly paleta: string;
};

/**
 * O cartão "Tema da plataforma" de `/admin/marca` (#3790).
 *
 * Grava o ID da instalação em `platform_config`, não o CSS: a tela não é um
 * editor de tema, é uma ESCOLHA entre os temas que as extensões já oferecem.
 * Por isso o `<Select>` e não um campo de texto — o que a ação aceita é
 * exatamente o que esta lista mostra.
 *
 * "Nenhum" é uma escolha de primeira classe (apaga a linha), e por isso é o
 * primeiro item: quem não usa tema de extensão precisa poder voltar ao produto
 * de fábrica sem editar banco.
 */
export function TemaDaPlataforma({
  temas,
  escolhido,
}: {
  temas: readonly TemaOferecido[];
  escolhido: string | null;
}) {
  const t = useT();
  const router = useRouter();
  const [valor, setValor] = useState(escolhido ?? NENHUM);
  const [isPending, startTransition] = useTransition();

  function salvar(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startTransition(async () => {
      const resultado = await updatePlatformTheme(valor === NENHUM ? null : valor);
      if (resultado.ok) {
        toast.success(t("Tema da plataforma salvo."));
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
          <h2 className="text-base font-semibold">{t("Tema da plataforma")}</h2>
          <p className="text-sm text-text-muted">
            {t(
              "A paleta de superfícies, bordas e textos do login, do admin e das organizações que não escolheram tema. A cor de ação continua vindo da Marca.",
            )}
          </p>
        </div>

        {temas.length === 0 ? (
          <p data-testid="tema-da-plataforma-sem-extensoes" className="text-sm text-text-muted">
            {t(
              "Nenhuma extensão instalada oferece um tema. Instale uma extensão com tema para poder escolher.",
            )}
          </p>
        ) : (
          <div className="space-y-2">
            <Label htmlFor="tema-da-plataforma-escolha">{t("Tema")}</Label>
            <Select value={valor} onValueChange={setValor} disabled={isPending}>
              <SelectTrigger
                id="tema-da-plataforma-escolha"
                className="w-full max-w-80"
                aria-label={t("Tema da plataforma")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NENHUM}>{t("Nenhum")}</SelectItem>
                {temas.map((tema) => (
                  <SelectItem key={tema.instalacaoId} value={tema.instalacaoId}>
                    {`${tema.rotulo} v${tema.versao} — ${tema.paleta}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p id="tema-da-plataforma-ajuda" className="text-xs text-text-muted">
              {t(
                "Vale para quem não tem tema próprio: dentro de uma organização com tema escolhido, a paleta dela é que manda.",
              )}
            </p>
          </div>
        )}

        <div className="flex justify-end">
          <Button type="submit" disabled={isPending || temas.length === 0}>
            {isPending ? t("Salvando…") : t("Salvar tema")}
          </Button>
        </div>
      </Card>
    </form>
  );
}
