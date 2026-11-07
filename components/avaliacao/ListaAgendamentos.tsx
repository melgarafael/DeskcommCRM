"use client";

import { CartaoAgendamento } from "./CartaoAgendamento";
import { CarregandoAgendamentos, ListaVaziaAgendamentos } from "./EstadosVazios";
import type { AgendamentoAvaliacao } from "./tipos";

export function ListaAgendamentos({
  itens,
  carregando,
  onEditar,
  onNovo,
}: {
  itens: AgendamentoAvaliacao[];
  carregando: boolean;
  onEditar: (id: string) => void;
  onNovo: () => void;
}) {
  if (carregando) return <CarregandoAgendamentos />;
  if (itens.length === 0) return <ListaVaziaAgendamentos onNovo={onNovo} />;

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {itens.map((item) => (
        <CartaoAgendamento key={item.id} item={item} onEditar={() => onEditar(item.id)} />
      ))}
    </div>
  );
}
