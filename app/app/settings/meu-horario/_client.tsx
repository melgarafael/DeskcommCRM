"use client";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Block {
  day_of_week: number;
  starts_at: string;
  ends_at: string;
}

const DIAS = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];

export function MeuHorarioClient({ userId }: { userId: string }) {
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [salvando, setSalvando] = useState(false);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState(false);

  useEffect(() => {
    let cancelado = false;
    fetch("/api/v1/attendant-schedule")
      .then((r) => {
        if (!r.ok) throw new Error(`status ${r.status}`);
        return r.json();
      })
      .then((json: { data?: Block[] }) => {
        if (!cancelado) {
          setBlocks(json.data ?? []);
          setErro(false);
        }
      })
      .catch(() => {
        if (!cancelado) setErro(true);
      })
      .finally(() => {
        if (!cancelado) setLoading(false);
      });
    return () => {
      cancelado = true;
    };
  }, []);

  function blocoDoDia(dia: number): Block {
    return blocks.find((b) => b.day_of_week === dia) ?? { day_of_week: dia, starts_at: "", ends_at: "" };
  }

  function atualizarBloco(dia: number, campo: "starts_at" | "ends_at", valor: string) {
    setBlocks((prev) => {
      const existe = prev.find((b) => b.day_of_week === dia);
      if (existe) {
        return prev.map((b) => (b.day_of_week === dia ? { ...b, [campo]: valor } : b));
      }
      return [...prev, { day_of_week: dia, starts_at: "", ends_at: "", [campo]: valor } as Block];
    });
  }

  async function salvar() {
    setSalvando(true);
    try {
      const blocosValidos = blocks.filter((b) => b.starts_at && b.ends_at);
      const res = await fetch("/api/v1/attendant-schedule", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ user_id: userId, blocks: blocosValidos }),
      });
      if (!res.ok) {
        const json = (await res.json()) as { error?: { message?: string } };
        toast.error(json.error?.message ?? "Erro ao salvar.");
        return;
      }
      toast.success("Horário salvo.");
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {loading && <p className="text-sm text-muted-foreground">Carregando…</p>}
      {!loading && erro && (
        <p className="text-sm text-destructive">Erro ao carregar horário. Tente novamente.</p>
      )}
      {!loading && !erro && (
        <>
          {DIAS.map((nome, dia) => {
            const bloco = blocoDoDia(dia);
            return (
              <Card key={dia}>
                <CardContent className="flex items-center gap-3 py-3">
                  <span className="w-24 text-sm font-medium">{nome}</span>
                  <div className="flex flex-col gap-1">
                    <Label className="text-xs">Início</Label>
                    <Input
                      type="time"
                      value={bloco.starts_at}
                      onChange={(e) => atualizarBloco(dia, "starts_at", e.target.value)}
                      className="w-32"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label className="text-xs">Fim</Label>
                    <Input
                      type="time"
                      value={bloco.ends_at}
                      onChange={(e) => atualizarBloco(dia, "ends_at", e.target.value)}
                      className="w-32"
                    />
                  </div>
                </CardContent>
              </Card>
            );
          })}
          <Button type="button" onClick={salvar} disabled={salvando} className="self-start">
            {salvando ? "Salvando…" : "Salvar horário"}
          </Button>
        </>
      )}
    </div>
  );
}
