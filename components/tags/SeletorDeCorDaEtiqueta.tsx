"use client";
/**
 * Gatilho + paleta para a etiqueta NASCER colorida (#2718).
 *
 * É o MESMO vocabulário do painel de Settings — os oito tons medidos de
 * `PALETA_DE_ETIQUETAS`, cada um com nome em `NOME_DO_TOM` (escolher por
 * "Âmbar" chega ao mesmo lugar que escolher pelo círculo, e o leitor de tela
 * anuncia o tom; seletor livre recriaria em cada instalação o problema que a
 * paleta veio consertar — #1271/#2373). A prévia usa o `ChipDeEtiqueta` com a
 * cor FORÇADA, para não ser adivinhação escolher sem ver o resultado.
 *
 * O gatilho só existe para quem a rota não vai recusar: `POST
 * /api/v1/tags/vocabulario` exige `requireRole("manager")` + MFA, e a régua da
 * própria tela de Settings é "a tela não oferece o que a escrita recusa".
 * Agentes criam a tag sem cor, exatamente como antes — sem erro e sem ruído.
 */
import { useState } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { ChipDeEtiqueta } from "@/components/tags/ChipDeEtiqueta";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { ROLE_RANK } from "@/lib/auth/types";
import { NOME_DO_TOM, PALETA_DE_ETIQUETAS } from "@/lib/tags/cor-da-etiqueta";
import { useT } from "@/hooks/i18n/useT";
import { Palette } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

interface Props {
  /** Tom escolhido (`#rrggbb`) ou `null` = "Sem cor". */
  cor: string | null;
  onChange: (cor: string | null) => void;
  /** Nome digitado, só para a prévia do chip dentro do popover. */
  tag?: string;
  disabled?: boolean;
}

export function SeletorDeCorDaEtiqueta({ cor, onChange, tag, disabled }: Props) {
  const t = useT();
  const { activeOrg } = useAuth();
  const [aberto, setAberto] = useState(false);

  const podeDefinir =
    !!activeOrg && ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager;
  if (!podeDefinir) return null;

  return (
    <Popover open={aberto} onOpenChange={setAberto}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 w-7 shrink-0 p-0"
          disabled={disabled}
          title={t("Cor da etiqueta")}
          aria-label={t("Cor da etiqueta")}
          aria-expanded={aberto}
        >
          {cor ? (
            <span
              className="size-3 rounded-full"
              style={{ backgroundColor: cor }}
              aria-hidden
            />
          ) : (
            <Palette size={12} weight="regular" aria-hidden />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto p-3">
        <p className="mb-2 text-xs font-semibold text-text">
          {t("Cor da etiqueta")}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {PALETA_DE_ETIQUETAS.map((tom) => (
            <button
              key={tom}
              type="button"
              onClick={() => {
                onChange(tom);
                setAberto(false);
              }}
              aria-pressed={cor === tom}
              // O nome do tom é o rótulo acessível; a cor é reforço — a mesma
              // redundância não-cromática do painel de Settings.
              aria-label={t(NOME_DO_TOM[tom] ?? tom)}
              title={tom}
              className={cn(
                "size-7 rounded-full border-2 transition-transform",
                cor === tom
                  ? "border-foreground ring-2 ring-ring ring-offset-1 ring-offset-background"
                  : "border-transparent hover:scale-110",
              )}
              style={{ backgroundColor: tom }}
            />
          ))}
          <Button
            type="button"
            size="sm"
            variant={cor === null ? "default" : "outline"}
            aria-pressed={cor === null}
            onClick={() => {
              onChange(null);
              setAberto(false);
            }}
          >
            {t("Sem cor")}
          </Button>
        </div>
        {tag ? (
          <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
            <span>{t("Prévia:")}</span>
            <ChipDeEtiqueta tag={tag} cor={cor ?? undefined} />
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
