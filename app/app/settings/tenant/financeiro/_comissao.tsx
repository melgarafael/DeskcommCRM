"use client";
/**
 * AS REGRAS DE COMISSÃO.
 *
 * Sem esta lista, `commission_rules` não tinha porta nenhuma: a rota que lança
 * item resolve o percentual a partir dela, então toda comissão nascia 0% em
 * toda instalação, e a precedência escrita na migration 0240 nunca era exercida.
 *
 * ⚠️ A TELA EXPLICA A PRECEDÊNCIA, porque ela não é adivinhável e decide
 * dinheiro: a regra mais ESPECÍFICA vence, nunca a de maior percentual. Sem esse
 * texto, quem cadastrasse "Ana 40%" e depois "Ana em manicure 10%" concluiria
 * que a segunda foi ignorada.
 */
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";

export type Regra = {
  id: string;
  name: string;
  attendant_user_id: string | null;
  event_type_id: string | null;
  percent: number;
};

export type Pessoa = { user_id: string; name: string | null; email: string | null };
export type Servico = { id: string; name: string };

export function RegrasDeComissao({
  regras,
  pessoas,
  servicos,
  podeEditar,
  carregando,
  onCriar,
  onInativar,
}: {
  regras: Regra[];
  pessoas: Pessoa[];
  servicos: Servico[];
  podeEditar: boolean;
  carregando: boolean;
  onCriar: (corpo: Record<string, unknown>) => void;
  onInativar: (id: string) => void;
}) {
  const t = useT();
  const [pessoaId, setPessoaId] = useState("");
  const [servicoId, setServicoId] = useState("");
  const [percentual, setPercentual] = useState("");

  const numero = Number(String(percentual).replace(",", "."));
  const percentualValido = Number.isFinite(numero) && numero >= 0 && numero <= 100;
  // Pelo menos um alvo, que é o mesmo que o CHECK do banco exige: uma regra sem
  // pessoa e sem serviço seria a regra "de tudo", que é outra coisa.
  const temAlvo = pessoaId !== "" || servicoId !== "";

  const nomeDaPessoa = (id: string) => {
    const p = pessoas.find((x) => x.user_id === id);
    return p?.name ?? p?.email ?? t("alguém");
  };
  const nomeDoServico = (id: string) => servicos.find((x) => x.id === id)?.name ?? t("um serviço");

  const rotuloDe = (r: Regra) => {
    if (r.attendant_user_id && r.event_type_id) {
      return `${nomeDaPessoa(r.attendant_user_id)} · ${nomeDoServico(r.event_type_id)}`;
    }
    if (r.attendant_user_id) return nomeDaPessoa(r.attendant_user_id);
    if (r.event_type_id) return nomeDoServico(r.event_type_id);
    return r.name;
  };

  return (
    <section className="space-y-3 rounded-xl border p-4">
      <h2 className="font-semibold">{t("Comissão")}</h2>
      <p className="text-sm text-text-muted">
        {t("Quanto cada pessoa recebe por atendimento. Sem regra, a comissão é zero.")}
      </p>
      <p className="text-xs text-text-muted">
        {t(
          "A regra mais específica vence: pessoa e serviço vence pessoa, que vence serviço. Não é o maior percentual que ganha.",
        )}
      </p>

      {podeEditar ? (
        <div className="flex flex-wrap items-end gap-2">
          <select
            aria-label={t("Pessoa")}
            className="min-h-11 rounded-md border p-2"
            value={pessoaId}
            onChange={(e) => setPessoaId(e.target.value)}
          >
            <option value="">{t("Qualquer pessoa")}</option>
            {pessoas.map((p) => (
              <option key={p.user_id} value={p.user_id}>
                {p.name ?? p.email}
              </option>
            ))}
          </select>

          <select
            aria-label={t("Serviço")}
            className="min-h-11 rounded-md border p-2"
            value={servicoId}
            onChange={(e) => setServicoId(e.target.value)}
          >
            <option value="">{t("Qualquer serviço")}</option>
            {servicos.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>

          <input
            aria-label={t("Percentual")}
            className="min-h-11 w-24 rounded-md border p-2"
            placeholder="30"
            inputMode="decimal"
            value={percentual}
            onChange={(e) => setPercentual(e.target.value)}
          />

          <Button
            className="min-h-11"
            disabled={!temAlvo || !percentualValido || percentual === ""}
            onClick={() =>
              onCriar({
                // O nome é montado a partir do que foi escolhido, e continua
                // editável no banco: é rótulo de lista, não a regra.
                name:
                  pessoaId && servicoId
                    ? `${nomeDaPessoa(pessoaId)} · ${nomeDoServico(servicoId)}`
                    : pessoaId
                      ? nomeDaPessoa(pessoaId)
                      : nomeDoServico(servicoId),
                attendant_user_id: pessoaId || null,
                event_type_id: servicoId || null,
                percent: numero,
              })
            }
          >
            {t("Adicionar regra")}
          </Button>

          {!temAlvo ? (
            <p className="w-full text-xs text-text-muted">
              {t("Escolha ao menos uma pessoa ou um serviço.")}
            </p>
          ) : null}
        </div>
      ) : null}

      {carregando ? (
        <p className="text-sm text-text-muted">{t("Carregando...")}</p>
      ) : regras.length === 0 ? (
        <p className="text-sm text-text-muted">
          {t("Nenhuma regra de comissão. Todo item entra com zero.")}
        </p>
      ) : (
        <ul className="space-y-1">
          {regras.map((r) => (
            <li
              key={r.id}
              className="flex items-center justify-between rounded-md border border-border p-2 text-sm"
            >
              <span>
                {rotuloDe(r)} · {r.percent}%
              </span>
              {podeEditar ? (
                <button
                  type="button"
                  aria-label={t("Remover regra")}
                  onClick={() => onInativar(r.id)}
                  className="text-text-muted hover:text-text"
                >
                  ×
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
