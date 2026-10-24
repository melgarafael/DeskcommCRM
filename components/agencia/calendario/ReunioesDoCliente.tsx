"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import type { ApoioDaAgenda } from "@/lib/agencia/calendario/apoio";
import type { ReuniaoDaAgenda } from "@/lib/agencia/calendario/consultas";
import { diaDe, horaLocal, rotuloLongoDoDia } from "@/lib/agencia/calendario/regras";
import { COR_DO_TIPO, ROTULO_DA_SITUACAO } from "@/lib/agencia/calendario/vocabulario";
import { diaLocal } from "@/lib/agencia/tarefas/regras";
import { cn } from "@/lib/utils";

import { ModalDaReuniao } from "./ModalDaReuniao";

/** A aba Reuniões da ficha do cliente (SPEC-calendario › Telas): próximas primeiro, depois as que já passaram. */
export function ReunioesDoCliente(p: {
  clienteId: string;
  reunioes: ReuniaoDaAgenda[];
  apoio: ApoioDaAgenda;
  meuMembroId: string | null;
  podeGerenciar: boolean;
  agendaLiberada: boolean;
}) {
  const router = useRouter();
  const [aberta, setAberta] = useState<ReuniaoDaAgenda | null>(null);
  const [nova, setNova] = useState(false);
  const [agora] = useState(() => Date.now());

  const proximas = p.reunioes.filter((r) => new Date(r.fim).getTime() >= agora);
  const passadas = p.reunioes.filter((r) => new Date(r.fim).getTime() < agora).reverse();

  const lista = (itens: ReuniaoDaAgenda[], vazio: string) =>
    itens.length === 0 ? (
      <p className="text-sm text-muted-foreground">{vazio}</p>
    ) : (
      <ul className="divide-y rounded-md border">
        {itens.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              onClick={() => setAberta(r)}
              className={cn("flex w-full items-start gap-3 p-3 text-left text-sm hover:bg-accent/40", r.situacao === "cancelada" && "opacity-60")}
            >
              <span className="mt-1 h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: COR_DO_TIPO[r.tipo] }} aria-hidden />
              <span className="min-w-0 flex-1">
                <span className={cn("block truncate font-medium", r.situacao === "cancelada" && "line-through")}>{r.titulo}</span>
                <span className="block text-xs text-muted-foreground first-letter:uppercase">
                  {rotuloLongoDoDia(diaDe(r.inicio))}, {horaLocal(r.inicio)} · {ROTULO_DA_SITUACAO[r.situacao]}
                  {r.ata ? " · com ata" : ""}
                  {r.gravacaoUrl ? " · gravada" : ""}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    );

  return (
    <section className="space-y-4">
      {p.podeGerenciar && (
        <Button type="button" onClick={() => setNova(true)}>
          Nova reunião
        </Button>
      )}
      <div className="space-y-2">
        <h2 className="font-semibold">Próximas ({proximas.length})</h2>
        {lista(proximas, "Nenhuma reunião marcada.")}
      </div>
      <div className="space-y-2">
        <h2 className="font-semibold">Já aconteceram ({passadas.length})</h2>
        {lista(passadas, "Nenhuma ainda.")}
      </div>
      {(aberta || nova) && (
        <ModalDaReuniao
          key={aberta?.id ?? "nova"}
          aberto
          reuniao={aberta}
          nova={{ dia: diaLocal(new Date(agora)), hora: "10:00", clienteId: p.clienteId }}
          apoio={p.apoio}
          meuMembroId={p.meuMembroId}
          podeGerenciar={p.podeGerenciar}
          agendaLiberada={p.agendaLiberada}
          aoFechar={(mudou) => {
            setAberta(null);
            setNova(false);
            if (mudou) router.refresh();
          }}
        />
      )}
    </section>
  );
}
