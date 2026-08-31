"use client";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface AppointmentType {
  id: string;
  name: string;
  duration_minutes: number;
  responsible_user_id: string;
  is_active: boolean;
}

export function AppointmentTypesClient() {
  const [items, setItems] = useState<AppointmentType[]>([]);
  const [name, setName] = useState("");
  const [duration, setDuration] = useState(30);
  const [responsibleUserId, setResponsibleUserId] = useState("");
  const [salvando, setSalvando] = useState(false);

  async function carregar() {
    const res = await fetch("/api/v1/appointment-types");
    const json = (await res.json()) as { data?: AppointmentType[] };
    setItems(json.data ?? []);
  }

  useEffect(() => {
    let cancelado = false;
    fetch("/api/v1/appointment-types")
      .then((r) => {
        if (!r.ok) throw new Error(`status ${r.status}`);
        return r.json();
      })
      .then((json: { data?: AppointmentType[] }) => {
        if (!cancelado) {
          setItems(json.data ?? []);
        }
      });
    return () => {
      cancelado = true;
    };
  }, []);

  async function criar() {
    if (!name.trim() || !responsibleUserId.trim()) {
      toast.error("Preencha nome e responsável.");
      return;
    }
    setSalvando(true);
    try {
      const res = await fetch("/api/v1/appointment-types", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, duration_minutes: duration, responsible_user_id: responsibleUserId }),
      });
      if (!res.ok) {
        const json = (await res.json()) as { error?: { message?: string } };
        toast.error(json.error?.message ?? "Erro ao criar.");
        return;
      }
      setName("");
      setResponsibleUserId("");
      await carregar();
      toast.success("Tipo criado.");
    } finally {
      setSalvando(false);
    }
  }

  async function excluir(id: string) {
    const res = await fetch(`/api/v1/appointment-types/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const json = (await res.json()) as { error?: { message?: string } };
      toast.error(json.error?.message ?? "Erro ao excluir.");
      return;
    }
    await carregar();
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 py-4">
          <div className="flex flex-col gap-1">
            <Label htmlFor="type-name">Nome</Label>
            <Input id="type-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Consulta" />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="type-duration">Duração (min)</Label>
            <Input
              id="type-duration"
              type="number"
              min={5}
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
              className="w-24"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="type-responsible">ID do responsável (usuário)</Label>
            <Input
              id="type-responsible"
              value={responsibleUserId}
              onChange={(e) => setResponsibleUserId(e.target.value)}
              placeholder="uuid do usuário"
              className="w-72"
            />
          </div>
          <Button type="button" onClick={criar} disabled={salvando}>
            {salvando ? "Salvando…" : "Criar tipo"}
          </Button>
        </CardContent>
      </Card>

      <div className="flex flex-col gap-2">
        {items.map((item) => (
          <Card key={item.id}>
            <CardContent className="flex items-center justify-between py-3">
              <span className="text-sm">
                {item.name} · {item.duration_minutes} min {item.is_active ? "" : "· (arquivado)"}
              </span>
              <Button variant="outline" size="sm" onClick={() => void excluir(item.id)}>
                Excluir
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
