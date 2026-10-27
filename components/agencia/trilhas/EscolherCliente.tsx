"use client";

import { useRouter } from "next/navigation";

/** "Ver a trilha de…": troca de cliente sem sair da aba Trilhas. */
export function EscolherCliente({ clientes, atual }: { clientes: Array<{ id: string; nome: string }>; atual?: string }) {
  const router = useRouter();
  return (
    <select
      aria-label="Ver a trilha de outro cliente"
      value={atual ?? ""}
      onChange={(e) => e.target.value && router.push(`/agencia/trilhas/${e.target.value}`)}
      className="h-9 max-w-[16rem] rounded-md border bg-background px-2 text-sm"
      data-testid="escolher-cliente-da-trilha"
    >
      {!atual && <option value="">Ver a trilha de…</option>}
      {clientes.map((c) => (
        <option key={c.id} value={c.id}>
          {c.nome}
        </option>
      ))}
    </select>
  );
}
