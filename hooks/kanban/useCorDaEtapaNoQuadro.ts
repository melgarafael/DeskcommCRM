"use client";
import { useCallback, useEffect, useState } from "react";

/** Onde a escolha mora. Constante exportada para o teste não repetir o literal. */
export const CHAVE_DA_COR_DA_ETAPA = "quadro:cor-da-etapa";

export type CorDaEtapaNoQuadro = "bolinha" | "coluna";

/**
 * Como o quadro mostra a cor da etapa (#4802, item 2, continuação do #4846):
 * só na bolinha ao lado do nome (o padrão, como sempre foi) ou na coluna inteira,
 * em tom pastel.
 *
 * É preferência de quem olha, não configuração da organização, pelo mesmo motivo
 * da densidade dos cards (`useDensidadeDoQuadro`, #3461): guardada no NAVEGADOR,
 * sem migration e sem rota. Quem gosta da bolinha não precisa fazer nada, e
 * quem prefere a coluna liga uma vez.
 *
 * O estado nasce "bolinha" e o valor gravado entra num efeito, um render depois:
 * ler `localStorage` no inicializador daria HTML diferente do hidratado (o
 * servidor não o tem) e um erro de hidratação.
 */
export function useCorDaEtapaNoQuadro(): {
  modo: CorDaEtapaNoQuadro;
  naColuna: boolean;
  alternar: () => void;
} {
  const [modo, setModo] = useState<CorDaEtapaNoQuadro>("bolinha");

  useEffect(() => {
    try {
      if (window.localStorage.getItem(CHAVE_DA_COR_DA_ETAPA) === "coluna") {
        setModo("coluna");
      }
    } catch {
      // `localStorage` bloqueado: a preferência não é essencial — fica a bolinha,
      // que é o padrão, e o quadro continua funcionando.
    }
  }, []);

  const alternar = useCallback(() => {
    setModo((atual) => {
      const proximo: CorDaEtapaNoQuadro = atual === "coluna" ? "bolinha" : "coluna";
      try {
        window.localStorage.setItem(CHAVE_DA_COR_DA_ETAPA, proximo);
      } catch {
        // idem: gravar é o ideal, não o requisito.
      }
      return proximo;
    });
  }, []);

  return { modo, naColuna: modo === "coluna", alternar };
}
