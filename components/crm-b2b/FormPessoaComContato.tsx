"use client";

import { useState, type FormEvent } from "react";

import { CamposDoVinculo, VINCULO_VAZIO, type Vinculo } from "@/components/crm-b2b/CamposDoVinculo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useActiveOrg } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { perfilDoPais } from "@/lib/legal/perfil-do-pais";

interface Props {
  empresaId: string;
  /** Chamado depois de gravar com sucesso. */
  onSalvo: () => void;
  /** Botão da esquerda ("Cancelar" no diálogo da empresa, "Pular por agora" no passo 2 do cadastro). */
  rotuloSecundario: string;
  onSecundario: () => void;
  /** Avisa o diálogo de fora, para ele não fechar (Esc, X) no meio da gravação. */
  onSalvandoChange?: (salvando: boolean) => void;
}

/**
 * Pessoa nova com o contato dela (telefone/e-mail), já ligada à empresa. Uma
 * chamada só (`POST /api/v1/companies/:id/contatos`): o servidor cria pessoa,
 * contato e vínculos, e desfaz tudo se algo falhar. Serve ao diálogo da página
 * da empresa e ao 2º passo do "Nova empresa". O estado nasce e morre com o
 * formulário (quem usa o monta de novo a cada abertura).
 */
export function FormPessoaComContato({
  empresaId,
  onSalvo,
  rotuloSecundario,
  onSecundario,
  onSalvandoChange,
}: Props) {
  const t = useT();
  const perfil = perfilDoPais(useActiveOrg()?.country);
  const [nome, setNome] = useState("");
  const [vinculo, setVinculo] = useState<Vinculo>(VINCULO_VAZIO);
  const [telefone, setTelefone] = useState("");
  const [email, setEmail] = useState("");
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  function mudaSalvando(v: boolean) {
    setSalvando(v);
    onSalvandoChange?.(v);
  }

  async function salvar(e: FormEvent) {
    e.preventDefault();
    if (salvando || !nome.trim()) return;
    mudaSalvando(true);
    setErro(null);
    try {
      const res = await fetch(`/api/v1/companies/${empresaId}/contatos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          full_name: nome.trim(),
          job_title: vinculo.job_title.trim() || null,
          is_decision_maker: vinculo.is_decision_maker,
          phone_number: telefone.trim() || undefined,
          email: email.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        // A frase útil ("Telefone deve ter DDD + número…") vem em `issues`; `message` é o genérico.
        const campo = json?.error?.details?.issues?.[0]?.message as string | undefined;
        setErro(campo || json?.error?.message || t("Não foi possível salvar."));
        return;
      }
      onSalvo();
    } finally {
      mudaSalvando(false);
    }
  }

  return (
    <form onSubmit={(e) => void salvar(e)} className="grid gap-3">
      <div className="grid gap-1.5">
        <Label htmlFor="pc-nome">{t("Nome")}</Label>
        <Input
          id="pc-nome"
          autoFocus
          value={nome}
          maxLength={200}
          onChange={(e) => setNome(e.target.value)}
        />
      </div>
      <CamposDoVinculo valor={vinculo} onChange={setVinculo} />
      <div className="grid gap-1.5">
        <Label htmlFor="pc-telefone">{t("Telefone / WhatsApp")}</Label>
        <Input
          id="pc-telefone"
          inputMode="tel"
          placeholder={perfil.telefoneExemplo}
          value={telefone}
          onChange={(e) => setTelefone(e.target.value)}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="pc-email">{t("E-mail")}</Label>
        <Input
          id="pc-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {t("Sem telefone nem e-mail, só a pessoa é cadastrada, ligada à empresa.")}
      </p>
      {erro ? (
        <p className="text-sm text-destructive" role="alert">
          {erro}
        </p>
      ) : null}
      <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" onClick={onSecundario} disabled={salvando}>
          {rotuloSecundario}
        </Button>
        <Button type="submit" disabled={salvando || !nome.trim()}>
          {salvando ? t("Salvando…") : t("Salvar")}
        </Button>
      </div>
    </form>
  );
}
