"use client";

import { useState, useTransition } from "react";

import { signOut } from "@/app/actions/auth/signOut";
import {
  aceitarLogado,
  criarContaPeloConvite,
  entrarPeloConvite,
} from "@/app/actions/agencia/aceitarConvite";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function AceiteDoConvite({
  token,
  email,
  estado,
  emailDaSessao,
}: {
  token: string;
  email: string;
  estado: "logado_certo" | "logado_errado" | "sem_login";
  emailDaSessao: string | null;
}) {
  const [modo, setModo] = useState<"criar" | "entrar">("criar");
  const [senha, setSenha] = useState("");
  const [confirma, setConfirma] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [pendente, startTransition] = useTransition();

  if (estado === "logado_errado") {
    return (
      <div className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          Você está conectado como <strong>{emailDaSessao}</strong>, mas este convite é para <strong>{email}</strong>.
        </p>
        <Button variant="outline" className="w-full" onClick={() => startTransition(async () => { await signOut(); })}>
          Sair desta conta
        </Button>
      </div>
    );
  }

  if (estado === "logado_certo") {
    return (
      <div className="space-y-3">
        {erro && <p role="alert" className="text-sm text-destructive">{erro}</p>}
        <Button
          className="w-full"
          disabled={pendente}
          onClick={() =>
            startTransition(async () => {
              const r = await aceitarLogado(token);
              if (r && !r.ok) setErro(r.erro);
            })
          }
        >
          Entrar na área da agência
        </Button>
      </div>
    );
  }

  function enviar(e: React.FormEvent) {
    e.preventDefault();
    setErro(null);
    if (modo === "criar" && senha !== confirma) {
      setErro("As duas senhas não são iguais.");
      return;
    }
    startTransition(async () => {
      const r = modo === "criar" ? await criarContaPeloConvite(token, senha) : await entrarPeloConvite(token, senha);
      if (r && !r.ok) {
        setErro(r.erro);
        if (r.jaTemConta) {
          setModo("entrar");
          setConfirma("");
        }
      }
    });
  }

  return (
    <form onSubmit={enviar} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="convite-email">E-mail</Label>
        <Input id="convite-email" value={email} disabled />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="convite-senha">{modo === "criar" ? "Crie uma senha" : "Sua senha"}</Label>
        <Input
          id="convite-senha"
          type="password"
          autoComplete={modo === "criar" ? "new-password" : "current-password"}
          value={senha}
          onChange={(e) => setSenha(e.target.value)}
          required
          minLength={modo === "criar" ? 8 : undefined}
        />
      </div>
      {modo === "criar" && (
        <div className="space-y-1.5">
          <Label htmlFor="convite-confirma">Repita a senha</Label>
          <Input
            id="convite-confirma"
            type="password"
            autoComplete="new-password"
            value={confirma}
            onChange={(e) => setConfirma(e.target.value)}
            required
          />
        </div>
      )}
      {erro && (
        <p role="alert" className="text-sm text-destructive">
          {erro}
        </p>
      )}
      <Button type="submit" className="w-full" disabled={pendente}>
        {pendente ? "Entrando…" : modo === "criar" ? "Criar senha e entrar" : "Entrar"}
      </Button>
      <button
        type="button"
        className="w-full text-center text-xs text-muted-foreground underline underline-offset-4"
        onClick={() => {
          setModo(modo === "criar" ? "entrar" : "criar");
          setErro(null);
        }}
      >
        {modo === "criar" ? "Já tenho conta com este e-mail" : "Ainda não tenho senha"}
      </button>
    </form>
  );
}
