"use client";

/**
 * AS CATEGORIAS DE PERDA DO FUNIL (#4437) — o cadastro que a tela de Funis
 * edita: acrescentar, renomear e esconder.
 *
 * ─── Por que isto existe ────────────────────────────────────────────────────
 *
 * A lista era do PRODUTO (`CATEGORIAS_DE_PERDA`: Cliente, Concorrência, Mérito,
 * Nós, Ausência), fixa no código. Uma clínica não perde por "Concorrência" e uma
 * loja precisa de "Risco"; e quem tinha uma categoria fora da lista — o
 * "Possível fraude" com "Risco", gravado à mão antes desta tela existir — via a
 * categoria sumir no primeiro rename, porque o menu só oferecia a lista fixa
 * somada à categoria atual daquele motivo.
 *
 * ─── As três operações, e o que cada uma NÃO faz ───────────────────────────
 *
 * - ACRESCENTAR só põe o nome na lista. Nada é atribuído automaticamente: quem
 *   decide qual motivo é de qual categoria é o menu de cada motivo.
 * - RENOMEAR troca o nome e o pai reescreve a categoria dos motivos que usavam
 *   o nome antigo (`aoRenomear`). Sem isso, renomear a categoria órfãva todos os
 *   motivos que apontavam para ela — o mesmo defeito do rename de motivo, um
 *   nível acima.
 * - ESCONDER é remover da lista, e SÓ isso. O `categoria` gravado no motivo não
 *   é tocado: quem já era "Mérito" continua agrupado como "Mérito" no relatório
 *   e continua vendo "Mérito" no próprio menu. O que muda é que a categoria
 *   deixa de ser oferecida aos OUTROS motivos — que é o que "não uso" significa.
 *   Por isso o contador "em uso" aparece na linha: esconder uma categoria em uso
 *   é decisão com consequência visível, não um clique silencioso.
 */
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import {
  MAX_CARACTERES_DA_CATEGORIA_DE_PERDA,
  MAX_CATEGORIAS_DE_PERDA,
} from "@/lib/schemas/leads";

export interface CategoriasDePerdaProps {
  /** As categorias declaradas, na ordem da tela. */
  categorias: string[];
  /** Quantos motivos usam cada categoria — a consequência de esconder. */
  emUso: Record<string, number>;
  aoMudar: (proximas: string[]) => void;
  /** Renomear categoria carrega os motivos que a usavam. */
  aoRenomear: (de: string, para: string) => void;
}

export function CategoriasDePerda({
  categorias,
  emUso,
  aoMudar,
  aoRenomear,
}: CategoriasDePerdaProps) {
  const t = useT();
  const [nova, setNova] = useState("");
  const [rascunhos, setRascunhos] = useState<Record<string, string>>({});
  const [erro, setErro] = useState<string | null>(null);

  const nomeLimpo = (valor: string) => valor.trim();

  const acrescentar = () => {
    const nome = nomeLimpo(nova);
    if (!nome) return;
    if (nome.length > MAX_CARACTERES_DA_CATEGORIA_DE_PERDA) {
      setErro(t("Categoria longa demais."));
      return;
    }
    if (categorias.includes(nome)) {
      setErro(t("Esta categoria já existe neste funil."));
      return;
    }
    if (categorias.length >= MAX_CATEGORIAS_DE_PERDA) {
      setErro(t("Limite de categorias deste funil atingido."));
      return;
    }
    setErro(null);
    setNova("");
    aoMudar([...categorias, nome]);
  };

  /**
   * Renomear confirma no blur/Enter, não a cada tecla: a cada tecla o nome
   * antigo deixaria de existir no meio da edição e os motivos perderiam o
   * vínculo por um instante — e um save no meio da digitação gravaria o órfão.
   */
  const confirmarRenome = (de: string) => {
    const para = nomeLimpo(rascunhos[de] ?? de);
    const limpar = () => setRascunhos((atual) => {
      const proximo = { ...atual };
      delete proximo[de];
      return proximo;
    });
    if (para === de) {
      limpar();
      return;
    }
    if (!para || para.length > MAX_CARACTERES_DA_CATEGORIA_DE_PERDA) {
      setErro(t("Categoria vazia ou longa demais."));
      limpar();
      return;
    }
    if (categorias.includes(para)) {
      setErro(t("Esta categoria já existe neste funil."));
      limpar();
      return;
    }
    setErro(null);
    limpar();
    aoMudar(categorias.map((c) => (c === de ? para : c)));
    aoRenomear(de, para);
  };

  const esconder = (alvo: string) => {
    setErro(null);
    aoMudar(categorias.filter((c) => c !== alvo));
  };

  return (
    <div className="space-y-1" data-testid="categorias-de-perda">
      <Label className="text-xs">{t("Categorias de perda deste funil")}</Label>
      <p className="text-xs text-muted-foreground">
        {t(
          "Agrupa o relatório de perdas e o filtro do quadro. Esconder uma categoria não tira do grupo o motivo que já a usa.",
        )}
      </p>
      <div className="flex flex-wrap gap-2">
        {categorias.map((categoria) => (
          <div
            key={categoria}
            data-testid={`categoria-${categoria}`}
            className="flex items-center gap-1 rounded-md border border-border px-2 py-1"
          >
            <Input
              aria-label={`${t("Renomear categoria")} ${categoria}`}
              className="h-7 w-36 text-xs"
              value={rascunhos[categoria] ?? categoria}
              onChange={(e) =>
                setRascunhos((atual) => ({ ...atual, [categoria]: e.target.value }))
              }
              onBlur={() => confirmarRenome(categoria)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  confirmarRenome(categoria);
                }
              }}
            />
            <span className="text-xs text-muted-foreground">
              {emUso[categoria] ? `${t("em uso")}: ${emUso[categoria]}` : t("sem uso")}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              aria-label={`${t("Esconder categoria")} ${categoria}`}
              onClick={() => esconder(categoria)}
            >
              {t("Esconder")}
            </Button>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 pt-1">
        <Input
          aria-label={t("Nova categoria")}
          placeholder={t("Nova categoria")}
          className="h-8 w-56 text-xs"
          value={nova}
          onChange={(e) => setNova(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              acrescentar();
            }
          }}
        />
        <Button type="button" variant="outline" size="sm" className="h-8 text-xs" onClick={acrescentar}>
          {t("Acrescentar")}
        </Button>
      </div>
      {erro ? <p className="text-xs text-destructive">{erro}</p> : null}
    </div>
  );
}
