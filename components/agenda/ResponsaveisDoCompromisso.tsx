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
  travada,
}: {
  principalId: string;
  gravados: string[];
  rascunho: string[] | null;
  podeEditar: boolean;
  desabilitado: boolean;
  onChange: (ids: string[]) => void;
  onSalvar: (ids: string[]) => void;
  /** Sessão coletiva: a equipe é travada por quem abre a sessão (#3067). */
  travada?: boolean;
}) {
  const t = useT();
  const { data: pessoas = [] } = usePessoasDaAgenda();
  if (!pessoas.length) return null;

  const nomesGravados = gravados.flatMap((id) => pessoas.find((p) => p.id === id)?.nome ?? []);

  if (travada && (podeEditar || nomesGravados.length > 0)) {
    // Somente leitura: mostra quem conduz e a nota de que a equipe é definida
    // por quem abre a sessão. Mostra a nota mesmo sem nomes, se pode editar.
    const mostrarNomes = nomesGravados.length > 0;
    return (
      <p data-testid="compromisso-quem-conduz" className="space-y-1">
        {mostrarNomes && (
          <>
            {t("Conduz com")}: {nomesGravados.join(", ")}
            <br />
          </>
        )}
        {podeEditar && (
          <span className="text-xs text-text-muted" data-testid="compromisso-equipe-travada">
            {t("A equipe desta sessão coletiva é definida por quem abre a sessão.")}
          </span>
        )}
      </p>
    );
  }

  if (!podeEditar) {
    return nomesGravados.length ? (
      <p data-testid="compromisso-quem-conduz">
        {t("Conduz com")}: {nomesGravados.join(", ")}
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
