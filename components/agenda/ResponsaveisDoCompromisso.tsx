"use client";

import { Button } from "@/components/ui/button";
import { usePessoasDaAgenda } from "@/hooks/agenda/usePessoasDaAgenda";
import { useT } from "@/hooks/i18n/useT";

import { QuemConduz } from "./QuemConduz";

/**
 * QUEM CONDUZ no detalhe do compromisso (#3067). O rascunho mora no detalhe,
 * para "Descartar rascunho" valer aqui também. `null` = ninguém mexeu.
 */
export function ResponsaveisDoCompromisso({
  principalId,
  gravados,
  rascunho,
  podeEditar,
  desabilitado,
  onChange,
  onSalvar,
}: {
  principalId: string;
  gravados: string[];
  rascunho: string[] | null;
  podeEditar: boolean;
  desabilitado: boolean;
  onChange: (ids: string[]) => void;
  onSalvar: (ids: string[]) => void;
}) {
  const t = useT();
  const { data: pessoas = [] } = usePessoasDaAgenda();
  if (!pessoas.length) return null;

  if (!podeEditar) {
    const nomes = gravados.flatMap((id) => pessoas.find((p) => p.id === id)?.nome ?? []);
    return nomes.length ? (
      <p data-testid="compromisso-quem-conduz">
        {t("Conduz com")}: {nomes.join(", ")}
      </p>
    ) : null;
  }

  const mudou =
    rascunho !== null &&
    (rascunho.length !== gravados.length || rascunho.some((id) => !gravados.includes(id)));

  return (
    <div className="space-y-2" data-testid="compromisso-quem-conduz">
      <QuemConduz
        pessoas={pessoas}
        principalId={principalId}
        selecionados={rascunho ?? gravados}
        onChange={onChange}
      />
      {mudou ? (
        <Button disabled={desabilitado} onClick={() => onSalvar(rascunho)}>
          {t("Salvar quem conduz")}
        </Button>
      ) : null}
    </div>
  );
}
