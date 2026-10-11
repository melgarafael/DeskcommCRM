"use client";

import { useT } from "@/hooks/i18n/useT";
import {
  AVISO_ESCRITA,
  AVISO_LEITURA_AMPLA,
  AVISO_ROLE,
  AVISO_SEM_CONFERIR,
} from "@/lib/external-db/dialetos/mysql/grants";

/**
 * O aviso do último teste, em amarelo e SEPARADO do erro: o teste passou, mas há
 * algo que a pessoa deveria saber (por exemplo, que o usuário do banco pode
 * escrever). O servidor grava as frases conhecidas de `grants.ts` unidas por
 * espaço; cada uma vira uma linha traduzida POR CONSTANTE (o gate de i18n não
 * aceita `t(variável)`). Texto que não é nenhuma delas aparece como veio.
 */
export function AvisoDoTeste({ aviso }: { aviso: string | null }) {
  const t = useT();
  if (!aviso) return null;
  const tem = (frase: string): boolean => aviso.includes(frase);
  const conhecido = tem(AVISO_ESCRITA) || tem(AVISO_LEITURA_AMPLA) || tem(AVISO_ROLE) || tem(AVISO_SEM_CONFERIR);
  return (
    <div role="status" className="space-y-0.5 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
      {tem(AVISO_ESCRITA) && <p>{t(AVISO_ESCRITA)}</p>}
      {tem(AVISO_LEITURA_AMPLA) && <p>{t(AVISO_LEITURA_AMPLA)}</p>}
      {tem(AVISO_ROLE) && <p>{t(AVISO_ROLE)}</p>}
      {tem(AVISO_SEM_CONFERIR) && <p>{t(AVISO_SEM_CONFERIR)}</p>}
      {!conhecido && <p>{aviso}</p>}
    </div>
  );
}
