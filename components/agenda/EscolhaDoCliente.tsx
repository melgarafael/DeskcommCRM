"use client";
import { useId, useState } from "react";

import { useT } from "@/hooks/i18n/useT";

export type ContatoDaAgenda = { id: string; name: string; email?: string | null };

/**
 * UM campo para uma escolha.
 *
 * Antes eram dois em sequência — "Buscar cliente" (texto) e "Quem será
 * atendido" (lista). Quem opera relatou pela tela que o segundo parecia que ia
 * abrir algo ao digitar, enquanto o primeiro parecia não fazer nada até a lista
 * mudar. Duas caixas para uma decisão só.
 *
 * ⛔ O PADRÃO É O VAZIO, e isso não é gosto: um seletor que abre já apontando
 * para o primeiro contato da lista marca compromisso no nome de outra pessoa.
 * Aconteceu nesta instalação — o cliente ficava herdado da abertura anterior do
 * painel — e foi consertado em 2026-09-12. Este componente não pode reintroduzir
 * o mesmo defeito por outro caminho.
 */
export function EscolhaDoCliente({
  contatos,
  valor,
  busca,
  onBusca,
  onEscolhe,
}: {
  contatos: ContatoDaAgenda[];
  /** `""` significa compromisso pessoal, sem cliente. É o padrão. */
  valor: string;
  busca: string;
  onBusca: (q: string) => void;
  onEscolhe: (id: string) => void;
}) {
  const t = useT();
  const id = useId();
  const [aberto, setAberto] = useState(false);
  const escolhido = contatos.find((c) => c.id === valor) ?? null;

  if (escolhido) {
    return (
      <div className="space-y-1">
        <span className="block text-xs font-medium text-text-muted">
          {t("Cliente do compromisso")}
        </span>
        <div className="flex items-center gap-2 rounded-md border bg-surface p-2">
          <span className="flex-1 truncate text-sm">{escolhido.name}</span>
          {/* O caminho de volta importa tanto quanto o de ida: sem ele, quem
              escolheu o contato errado só desfaz fechando o painel — e fechar o
              painel é justamente o gesto que causava a herança de cliente. */}
          <button
            type="button"
            className="rounded-md px-2 py-1 text-xs underline"
            onClick={() => {
              onEscolhe("");
              onBusca("");
            }}
          >
            {t("Tirar o cliente")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <label className="block text-xs font-medium text-text-muted" htmlFor={id}>
        {t("Cliente do compromisso")}
      </label>
      <input
        id={id}
        role="combobox"
        aria-expanded={aberto}
        aria-controls={`${id}-lista`}
        autoComplete="off"
        className="w-full rounded-md border bg-surface p-2 text-sm"
        placeholder={t("Digite para buscar um cliente")}
        value={busca}
        onFocus={() => setAberto(true)}
        onChange={(e) => {
          onBusca(e.target.value);
          setAberto(true);
        }}
      />
      <p className="text-xs text-text-muted">{t("Compromisso pessoal, sem cliente")}</p>
      {aberto && contatos.length > 0 ? (
        <ul
          id={`${id}-lista`}
          role="listbox"
          className="max-h-48 overflow-y-auto rounded-md border bg-surface"
        >
          {contatos.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                role="option"
                aria-selected={false}
                className="w-full px-2 py-1.5 text-left text-sm hover:bg-surface-muted"
                onClick={() => {
                  onEscolhe(c.id);
                  setAberto(false);
                }}
              >
                {c.name}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
