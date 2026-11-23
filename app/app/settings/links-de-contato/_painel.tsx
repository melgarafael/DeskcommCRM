"use client";

/**
 * O painel de marcar/desmarcar da tela de Tipos de link (#5128).
 *
 * A lista sai do CATÁLOGO (`TIPOS_DE_LINK`), na ordem dele — a tela mostra
 * exatamente o que a ficha pode mostrar. O estado inicial vem do servidor (a
 * escolha da organização, ou o catálogo inteiro quando não há escolha).
 *
 * Erro é INLINE (`role="alert"`), não só toast: um 403/422 que some em três
 * segundos deixa a pessoa achando que salvou.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useT } from "@/hooks/i18n/useT";
import { TIPOS_DE_LINK_POR_ORGANIZACAO_KEY } from "@/hooks/leads/useTiposDeLink";
import { ApiError } from "@/lib/api/types";
import { apiClient } from "@/lib/api/client";
import type { TipoDeLink } from "@/lib/leads/links-de-contato";
import { TIPOS_DE_LINK } from "@/lib/leads/links-de-contato";

export function PainelDosTiposDeLink({ tiposIniciais }: { tiposIniciais: TipoDeLink[] }) {
  const t = useT();
  const qc = useQueryClient();
  const [marcados, setMarcados] = useState<Set<TipoDeLink>>(() => new Set(tiposIniciais));
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState("");

  function alternar(tipo: TipoDeLink) {
    setMarcados((atuais) => {
      const proximo = new Set(atuais);
      if (proximo.has(tipo)) proximo.delete(tipo);
      else proximo.add(tipo);
      return proximo;
    });
    setErro("");
  }

  async function salvar() {
    // A leitura trata lista vazia como "catálogo inteiro". Salvar vazio daria a
    // impressão de esconder tudo e mostraria tudo — então a tela barra antes.
    if (marcados.size === 0) {
      setErro(t("Marque pelo menos um tipo de link."));
      return;
    }
    setSalvando(true);
    setErro("");
    try {
      const resposta = await apiClient.patch<{ data: { tipos: TipoDeLink[] } }>(
        "/api/v1/settings/links-de-contato",
        { tipos: TIPOS_DE_LINK.filter(({ id }) => marcados.has(id)).map(({ id }) => id) },
      );
      const tipos = resposta.data.tipos;
      setMarcados(new Set(tipos));
      // Ficha e cards leem a MESMA chave: sem invalidar, a tela salva e o funil
      // continua com a escolha antiga até o staleTime de 5 min.
      await qc.invalidateQueries({ queryKey: TIPOS_DE_LINK_POR_ORGANIZACAO_KEY });
      toast.success(t("Tipos de link salvos."));
    } catch (err) {
      setErro(
        err instanceof ApiError && err.semEnvelope
          ? t("Não foi possível salvar. Tente novamente.")
          : err instanceof ApiError && err.message
            ? err.message
            : t("Não foi possível salvar. Tente novamente."),
      );
    } finally {
      setSalvando(false);
    }
  }

  return (
    <Card className="space-y-4 p-6">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{t("Quais tipos a ficha mostra")}</h2>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t(
            "Os tipos desmarcados somem do formulário e da exibição da ficha e do funil. Nada é apagado: o valor preenchido continua guardado e volta a aparecer se o tipo for marcado de novo.",
          )}
        </p>
      </div>

      <ul className="grid gap-2 sm:grid-cols-2" data-testid="tipos-de-link">
        {TIPOS_DE_LINK.map((tipo) => (
          <li key={tipo.id}>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={marcados.has(tipo.id)}
                onChange={() => alternar(tipo.id)}
                className="h-4 w-4 rounded-md border-border"
              />
              {t(tipo.rotulo)}
            </label>
          </li>
        ))}
      </ul>

      {erro && (
        <p role="alert" className="text-sm text-destructive">
          {erro}
        </p>
      )}

      <Button type="button" onClick={salvar} disabled={salvando} data-testid="salvar-tipos-de-link">
        {salvando ? t("Salvando…") : t("Salvar tipos")}
      </Button>
    </Card>
  );
}
