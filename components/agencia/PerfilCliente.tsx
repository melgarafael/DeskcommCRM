"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { salvarMeuPerfil } from "@/app/actions/agencia/perfil";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

export function PerfilCliente({
  inicial,
  email,
  novo,
}: {
  inicial: { nome: string; whatsapp: string; recebeWhatsapp: boolean };
  email: string;
  novo: boolean;
}) {
  const router = useRouter();
  const [nome, setNome] = useState(inicial.nome);
  const [whatsapp, setWhatsapp] = useState(inicial.whatsapp);
  const [recebe, setRecebe] = useState(inicial.recebeWhatsapp);
  const [msg, setMsg] = useState<{ ok: boolean; texto: string } | null>(null);
  const [pendente, startTransition] = useTransition();

  function salvar(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const r = await salvarMeuPerfil({ nome, whatsapp, recebeWhatsapp: recebe });
      setMsg(r.ok ? { ok: true, texto: "Perfil salvo." } : { ok: false, texto: r.erro });
      if (r.ok) router.refresh();
    });
  }

  return (
    <form onSubmit={salvar} className="space-y-4 rounded-md border p-4">
      <div className="space-y-1.5">
        <Label htmlFor="perfil-nome">Nome</Label>
        <Input id="perfil-nome" value={nome} onChange={(e) => setNome(e.target.value)} required />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="perfil-email">E-mail</Label>
        <Input id="perfil-email" value={email} disabled />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="perfil-whatsapp">WhatsApp</Label>
        <Input
          id="perfil-whatsapp"
          inputMode="tel"
          placeholder="(11) 91234-5678"
          value={whatsapp}
          onChange={(e) => setWhatsapp(e.target.value)}
          required
        />
      </div>
      <label className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm">
        <span>
          Receber avisos no meu WhatsApp
          <span className="block text-xs text-muted-foreground">Desligado, os avisos aparecem só no sininho.</span>
        </span>
        <Switch checked={recebe} onCheckedChange={setRecebe} aria-label="Receber avisos no meu WhatsApp" />
      </label>
      {msg && (
        <p role="status" className={msg.ok ? "text-sm text-muted-foreground" : "text-sm text-destructive"}>
          {msg.texto}
        </p>
      )}
      <div className="flex justify-end">
        <Button type="submit" disabled={pendente}>
          {pendente ? "Salvando…" : novo ? "Ativar meu perfil" : "Salvar"}
        </Button>
      </div>
    </form>
  );
}
