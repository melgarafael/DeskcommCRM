"use client";

import { useT } from "@/hooks/i18n/useT";
import { TETO_ADICIONAIS, TETO_RESPONSAVEIS } from "@/lib/agenda/responsaveis";

import type { Pessoa } from "./tipos";

/**
 * QUEM CONDUZ (#3067): o principal e até nove adicionais. Quem está aqui ocupa a
 * agenda — diferente de "Equipe no compromisso", que só recebe o convite.
 * O principal não é escolhido neste campo; ele só aparece.
 */
export function QuemConduz({
  pessoas,
  principalId,
  selecionados,
  onChange,
  aviso,
}: {
  pessoas: Pessoa[];
  principalId: string | null;
  selecionados: string[];
  onChange: (ids: string[]) => void;
  aviso?: string;
}) {
  const t = useT();
  const nomeDe = (id: string) => pessoas.find((p) => p.id === id)?.nome;
  const adicionais = selecionados.filter((id) => id !== principalId && nomeDe(id) !== undefined);
  const livres = pessoas.filter((p) => p.id !== principalId && !adicionais.includes(p.id));
  const cheio = adicionais.length >= TETO_ADICIONAIS;
  const principal = principalId ? nomeDe(principalId) : undefined;
  const pilula = "inline-flex min-h-11 items-center rounded-full border px-3 py-1 text-xs lg:min-h-0";

  return (
    <fieldset data-testid="quem-conduz">
      <legend className="block">
        {t("Quem conduz")} <span className="font-normal opacity-70">({t("opcional")})</span>
      </legend>
      <p className="mt-1 text-xs text-text-muted">{t("Quem conduz fica com este horário ocupado.")}</p>
      {aviso ? (
        <p className="mt-1 text-xs text-text-muted" data-testid="quem-conduz-aviso">
          {aviso}
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {principal ? (
          <span data-testid="quem-conduz-principal" className={`${pilula} border-border-strong bg-surface-elevated`}>
            {principal} · {t("principal")}
          </span>
        ) : null}
        {adicionais.map((id) => (
          <button
            key={id}
            type="button"
            aria-label={t("Retirar {nome}").replace("{nome}", nomeDe(id) ?? "")}
            onClick={() => onChange(adicionais.filter((x) => x !== id))}
            className={`${pilula} gap-1 border-border-strong bg-surface-elevated`}
          >
            {nomeDe(id)} <span aria-hidden>×</span>
          </button>
        ))}
        {!cheio && livres.length > 0 ? (
          <select
            aria-label={t("Adicionar pessoa")}
            data-testid="quem-conduz-adicionar"
            value=""
            onChange={(e) => {
              if (e.target.value) onChange([...adicionais, e.target.value]);
            }}
            className={`${pilula} border-dashed border-border-strong bg-surface`}
          >
            <option value="">{t("Adicionar pessoa")}</option>
            {livres.map((p) => (
              <option key={p.id} value={p.id}>
                {p.nome}
              </option>
            ))}
          </select>
        ) : null}
        <span data-testid="quem-conduz-contador" className="ml-auto text-xs tabular-nums text-text-muted">
          {t("{n} de {teto}")
            .replace("{n}", String(adicionais.length + 1))
            .replace("{teto}", String(TETO_RESPONSAVEIS))}
        </span>
      </div>
    </fieldset>
  );
}
