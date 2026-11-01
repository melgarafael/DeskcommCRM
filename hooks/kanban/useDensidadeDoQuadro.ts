"use client";
import { useCallback, useEffect, useState } from "react";

/** Onde a escolha mora. Constante exportada para o teste não repetir o literal. */
export const CHAVE_DA_DENSIDADE = "quadro:densidade";

export type DensidadeDoQuadro = "confortavel" | "compacta";

/**
 * A densidade do quadro (issue #3461, item 2), guardada no NAVEGADOR.
 *
 * É preferência de quem olha, não configuração da organização: a mesma
 * operação quer ver muitos contatos, e um funil compartilhado não deve mudar de
 * altura porque alguém clicou. Por isso `localStorage` e não uma coluna em
 * `crm_pipelines.settings` — a régua é a mesma do tema e do idioma.
 *
 * ─── Por que o estado nasce "confortável" mesmo com "compacta" gravado ─────
 *
 * O primeiro render é o do SERVIDOR (a página é client component, mas ainda
 * renderiza no SSR), onde `localStorage` não existe. Ler no inicializador daria
 * um HTML compacto diferente do hidratado — erro de hidratação, e a tela
 * piscando a cada F5. Então o valor gravado entra num efeito, um render depois:
 * quem escolheu compacto vê o quadro confortável por um frame e compacto em
 * seguida, e NADA quebra.
 */
export function useDensidadeDoQuadro(): {
  densidade: DensidadeDoQuadro;
  compacta: boolean;
  alternar: () => void;
} {
  const [densidade, setDensidade] = useState<DensidadeDoQuadro>("confortavel");

  useEffect(() => {
    try {
      if (window.localStorage.getItem(CHAVE_DA_DENSIDADE) === "compacta") {
        setDensidade("compacta");
      }
    } catch {
      // `localStorage` bloqueado (modo privado de alguns navegadores, política
      // de cookies): a preferência não é essencial — o quadro fica confortável,
      // que é o padrão, e a tela continua funcionando.
    }
  }, []);

  const alternar = useCallback(() => {
    setDensidade((atual) => {
      const proxima: DensidadeDoQuadro = atual === "compacta" ? "confortavel" : "compacta";
      try {
        window.localStorage.setItem(CHAVE_DA_DENSIDADE, proxima);
      } catch {
        // idem: gravar é o ideal, não o requisito.
      }
      return proxima;
    });
  }, []);

  return { densidade, compacta: densidade === "compacta", alternar };
}
