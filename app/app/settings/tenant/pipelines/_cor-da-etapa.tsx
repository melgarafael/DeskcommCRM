"use client";
/**
 * O seletor de cor da etapa — item 2 da #4802.
 *
 * ─── O que ele resolve ─────────────────────────────────────────────────────
 *
 * `crm_stages.color` existia, o Kanban pintava, e NENHUMA tela escrevia: o
 * caminho era exportar o funil em JSON, editar e importar de novo. Aqui a cor
 * passa a se escolher onde a etapa é configurada.
 *
 * ─── Por que a paleta, e não um `<input type="color">` ─────────────────────
 *
 * É a MESMA fileira de tons da etiqueta (`PALETA_DE_ETAPAS` reexporta
 * `PALETA_DE_ETIQUETAS`) — oito tons medidos em #1271/#2373, cada um com NOME,
 * porque escolher por "Âmbar" alcança o mesmo lugar que escolher pelo círculo e
 * o leitor de tela anuncia o tom. Cor livre recriaria em cada instalação o
 * problema que a paleta veio consertar.
 *
 * ─── «Padrão» não é enfeite ────────────────────────────────────────────────
 *
 * O valor de hoje é `NULL`: o quadro desenha o ponto neutro (`text-muted/40`).
 * Sem o botão, quem pintasse uma etapa não teria como voltar atrás — e o único
 * jeito seria o mesmo import/export que esta fatia veio tirar do caminho. O
 * botão grava `color: null`, e é isso que o teste de restauração cobra.
 *
 * ─── A prévia ──────────────────────────────────────────────────────────────
 *
 * Mostra o nome da etapa SOBRE a cor, com a frente calculada por
 * `frenteSobreACor` (a régua de 4,5 do repo, #2373) — nunca branco fixo. O ponto
 * do quadro é só reforço; aqui, onde há texto, a régua manda.
 */
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useT } from "@/hooks/i18n/useT";
import {
  NOME_DO_TOM_DA_ETAPA,
  PALETA_DE_ETAPAS,
  corDaEtapaValida,
  frenteSobreACor,
} from "@/lib/leads/cor-da-etapa";
import { Palette } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

interface Props {
  etapa: { id: string; name: string; color?: string | null };
  desabilitado?: boolean;
  /** Grava a escolha: um tom da paleta, ou `null` para voltar ao padrão. */
  aoEscolher: (cor: string | null) => void;
}

export function CorDaEtapa({ etapa, desabilitado, aoEscolher }: Props) {
  const t = useT();
  const [aberto, setAberto] = useState(false);
  // Cor fora da paleta (importada à mão) continua mostrada como está: o que a
  // tela oferece não é o que o banco aceita, e fingir "sem cor" seria mentir
  // sobre o que o quadro já pinta.
  const cor = corDaEtapaValida(etapa.color) ? etapa.color : null;
  const rotulo = `${t("Cor da etapa")} «${etapa.name}»`;

  return (
    <Popover open={aberto} onOpenChange={setAberto}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 gap-2 px-2"
          disabled={desabilitado}
          aria-label={rotulo}
          title={rotulo}
          aria-expanded={aberto}
          data-testid={`cor-${etapa.id}`}
        >
          {cor ? (
            <span
              className="size-3.5 rounded-full"
              style={{ backgroundColor: cor }}
              aria-hidden
            />
          ) : (
            <Palette size={14} weight="regular" aria-hidden />
          )}
          <span className="text-xs" data-testid={`cor-nome-${etapa.id}`}>
            {cor ? t(NOME_DO_TOM_DA_ETAPA[cor] ?? "Cor escolhida") : t("Padrão")}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto max-w-[calc(100vw-2rem)] p-3">
        <p className="mb-2 text-xs font-semibold text-text">{rotulo}</p>
        <div className="flex flex-wrap items-center gap-2">
          {PALETA_DE_ETAPAS.map((tom) => (
            <button
              key={tom}
              type="button"
              onClick={() => {
                aoEscolher(tom);
                setAberto(false);
              }}
              aria-pressed={cor === tom}
              // O nome do tom é o rótulo acessível; a cor é reforço.
              aria-label={t(NOME_DO_TOM_DA_ETAPA[tom] ?? tom)}
              title={tom}
              data-testid={`tom-${tom.slice(1)}`}
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
            data-testid={`padrao-${etapa.id}`}
            onClick={() => {
              aoEscolher(null);
              setAberto(false);
            }}
          >
            {t("Padrão")}
          </Button>
        </div>
        <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
          <span>{t("Prévia:")}</span>
          <span
            data-testid={`previa-${etapa.id}`}
            className={cn(
              "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
              !cor && "border border-dashed border-border",
            )}
            style={cor ? { backgroundColor: cor, color: frenteSobreACor(cor) } : undefined}
          >
            {etapa.name}
          </span>
        </div>
      </PopoverContent>
    </Popover>
  );
}
