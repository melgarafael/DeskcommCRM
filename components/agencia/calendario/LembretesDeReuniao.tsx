"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { salvarLembretesDeReuniao } from "@/app/actions/agencia/reunioes";
import { Button } from "@/components/ui/button";
import { MARCOS_DE_LEMBRETE, ROTULO_DO_MARCO } from "@/lib/agencia/calendario/vocabulario";

/** Quando a equipe é lembrada das reuniões (SPEC-calendario, K7). */
export function LembretesDeReuniao({ inicial }: { inicial: number[] }) {
  const router = useRouter();
  const [marcos, setMarcos] = useState<number[]>(inicial);
  const [msg, setMsg] = useState<{ ok: boolean; texto: string } | null>(null);
  const [pendente, startTransition] = useTransition();

  return (
    <section className="space-y-3 rounded-md border p-4">
      <div className="space-y-1">
        <h2 className="font-semibold">Lembretes de reunião</h2>
        <p className="text-sm text-muted-foreground">
          Quem está na reunião recebe o lembrete no sininho e no WhatsApp. Cada lembrete sai uma vez.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {MARCOS_DE_LEMBRETE.map((m) => (
          <label key={m} className="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-sm has-[:checked]:border-foreground">
            <input
              type="checkbox"
              checked={marcos.includes(m)}
              onChange={(e) => setMarcos(e.target.checked ? [...marcos, m] : marcos.filter((x) => x !== m))}
            />
            {ROTULO_DO_MARCO[m]}
          </label>
        ))}
      </div>
      {msg && (
        <p role="status" className={msg.ok ? "text-sm text-muted-foreground" : "text-sm text-destructive"}>
          {msg.texto}
        </p>
      )}
      <Button
        type="button"
        disabled={pendente}
        onClick={() =>
          startTransition(async () => {
            const r = await salvarLembretesDeReuniao(marcos);
            setMsg(r.ok ? { ok: true, texto: marcos.length ? "Lembretes salvos." : "Lembretes desligados." } : { ok: false, texto: r.erro });
            router.refresh();
          })
        }
      >
        Salvar lembretes
      </Button>
    </section>
  );
}
