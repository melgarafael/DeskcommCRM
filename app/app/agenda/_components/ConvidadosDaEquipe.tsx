"use client";

import { useT } from "@/hooks/i18n/useT";
import { cn } from "@/lib/utils";

/**
 * CONVIDADOS DA EQUIPE NO COMPROMISSO (#4006).
 *
 * Numa equipe com SDR e closer, a SDR marca a reunião mas o responsável é o
 * closer; o gestor ou um especialista também precisa estar. O campo de e-mail
 * do convidado cobre UMA pessoa de fora — não cobre a própria equipe.
 *
 * ─── Por que lista de caixas, e não um campo de texto ─────────────────────
 *
 * O convite precisa do e-mail da CONTA GOOGLE de cada pessoa (a saudável; sem
 * ela, o login), e essa resolução é do servidor — `convidadosDaEquipe`. Digitar
 * e-mail de colega à mão erraria o endereço e o convidado não veria a reunião.
 *
 * ─── O que este componente NÃO faz ────────────────────────────────────────
 *
 * Não muda o dono do compromisso. Carteira, distribuição e métricas continuam
 * do responsável; aqui só se escolhe quem mais recebe o convite.
 */
export function ConvidadosDaEquipe({
  pessoas,
  selecionados,
  onSelecionados,
  desabilitado,
}: {
  pessoas: { user_id: string; display_label: string }[];
  selecionados: string[];
  onSelecionados: (ids: string[]) => void;
  desabilitado?: boolean;
}) {
  const t = useT();

  const alternar = (id: string) => {
    if (desabilitado) return;
    onSelecionados(
      selecionados.includes(id) ? selecionados.filter((x) => x !== id) : [...selecionados, id],
    );
  };

  return (
    <fieldset className="min-w-0">
      <legend className="block">
        {t("Convidados da equipe")}{" "}
        <span className="font-normal opacity-70">({t("opcional")})</span>
      </legend>
      <p className="mt-1 text-xs text-text-muted">
        {t(
          "Cada pessoa escolhida recebe o convite na conta Google dela e vê o compromisso na própria agenda. O responsável continua sendo quem responde pelo atendimento.",
        )}
      </p>
      <div
        data-testid="convidados-da-equipe"
        className="mt-2 max-h-40 space-y-1 overflow-y-auto rounded-md border border-border p-2"
      >
        {pessoas.length === 0 ? (
          <p className="text-xs text-text-muted">{t("Nenhuma pessoa disponível na sua equipe.")}</p>
        ) : (
          pessoas.map((pessoa) => (
            <label
              key={pessoa.user_id}
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-sm",
                desabilitado && "cursor-not-allowed opacity-60",
              )}
            >
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={selecionados.includes(pessoa.user_id)}
                onChange={() => alternar(pessoa.user_id)}
                disabled={desabilitado}
                data-testid={`convidado-${pessoa.user_id}`}
              />
              <span className="truncate">{pessoa.display_label}</span>
            </label>
          ))
        )}
      </div>
    </fieldset>
  );
}
