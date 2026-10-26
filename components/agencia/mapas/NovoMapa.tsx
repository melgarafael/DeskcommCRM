"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { criarMapa } from "@/app/actions/agencia/mapas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** "Novo mapa": escolhe o cliente e o nome, e abre a Criação. */
export function NovoMapa({ clientes }: { clientes: Array<{ id: string; nome: string }> }) {
  const router = useRouter();
  const [clienteId, setClienteId] = useState(clientes[0]?.id ?? "");
  const [titulo, setTitulo] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [pendente, startTransition] = useTransition();

  if (clientes.length === 0) return null;
  return (
    <div className="grid gap-3 rounded-md border p-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end" data-testid="novo-mapa">
      <div className="space-y-1">
        <Label htmlFor="mapa-cliente">Cliente</Label>
        <select id="mapa-cliente" value={clienteId} onChange={(e) => setClienteId(e.target.value)} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
          {clientes.map((c) => (
            <option key={c.id} value={c.id}>
              {c.nome}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="mapa-titulo">Nome do mapa</Label>
        <Input id="mapa-titulo" value={titulo} onChange={(e) => setTitulo(e.target.value)} placeholder="Ex.: Plano de dezembro" />
      </div>
      <Button
        type="button"
        disabled={pendente}
        onClick={() =>
          startTransition(async () => {
            const r = await criarMapa(clienteId, titulo);
            if (!r.ok) return setErro(r.erro);
            router.push(`/agencia/mapas/${r.dados.id}`);
          })
        }
      >
        Criar mapa
      </Button>
      {erro && (
        <p role="alert" className="text-sm text-destructive sm:col-span-3">
          {erro}
        </p>
      )}
    </div>
  );
}
