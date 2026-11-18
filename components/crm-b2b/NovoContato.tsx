"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { mensagemDeErro } from "@/components/crm-b2b/BuscarEEscolher";
import { telefoneOuEmail } from "@/components/crm-b2b/telefone-ou-email";
import { useT } from "@/hooks/i18n/useT";

export interface ContatoInicial {
  telefone: string;
  email: string;
}

/**
 * Contato novo já ligado à pessoa (issue #3198), com telefone E e-mail no
 * mesmo cadastro. Antes, digitar um e-mail criava um contato só de e-mail e
 * digitar o telefone criava outro, só de telefone — a mesma pessoa ficava com
 * dois contatos pela metade.
 *
 * Quem usa monta com `key`: cada abertura começa do `inicial` (o que foi
 * digitado na busca, e o e-mail da pessoa quando nenhum contato o usa).
 */
export function NovoContato({
  inicial,
  personId,
  nome,
  onFechar,
  onCriado,
}: {
  inicial: ContatoInicial | null;
  personId: string;
  nome: string;
  onFechar: () => void;
  onCriado: () => void;
}) {
  const t = useT();
  const [telefone, setTelefone] = useState(inicial?.telefone ?? "");
  const [email, setEmail] = useState(inicial?.email ?? "");
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  async function criar() {
    const fone = telefone.trim() ? telefoneOuEmail(telefone) : null;
    const mail = email.trim() ? telefoneOuEmail(email) : null;
    if (telefone.trim() && !(fone && "phone_number" in fone)) {
      setErro(t("Telefone inválido: use DDD e número."));
      return;
    }
    if (email.trim() && !(mail && "email" in mail)) {
      setErro(t("E-mail inválido."));
      return;
    }
    if (!fone && !mail) {
      setErro(t("Digite um telefone com DDD ou um e-mail."));
      return;
    }

    setSalvando(true);
    setErro(null);
    const res = await fetch("/api/v1/contacts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: nome, ...fone, ...mail, source: "manual" }),
    });
    let falha = await mensagemDeErro(res, t("Não foi possível salvar."));
    if (!falha) {
      const json = await res.json().catch(() => null);
      const novoId = json?.data?.contact?.id as string | undefined;
      if (!novoId) {
        falha = t("Não foi possível salvar.");
      } else {
        // Criado e ainda solto: liga à pessoa. Se esta parte falhar, o contato
        // fica cadastrado sem pessoa — como o lead que chega pelo WhatsApp.
        const liga = await fetch(`/api/v1/contacts/${novoId}/person`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ person_id: personId }),
        });
        falha = await mensagemDeErro(liga, t("Não foi possível salvar."));
        onCriado();
      }
    }
    setSalvando(false);
    if (falha) {
      setErro(falha);
      return;
    }
    onFechar();
  }

  return (
    <Dialog open={Boolean(inicial)} onOpenChange={(a) => (a ? null : onFechar())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Novo contato")}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 py-1">
          <div className="grid gap-1.5">
            <Label htmlFor="novo-contato-telefone">{t("Telefone")}</Label>
            <Input
              id="novo-contato-telefone"
              value={telefone}
              inputMode="tel"
              placeholder="(16) 99999-0001"
              onChange={(e) => setTelefone(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="novo-contato-email">{t("E-mail")}</Label>
            <Input
              id="novo-contato-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          {erro ? (
            <p className="text-sm text-destructive" role="alert">
              {erro}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onFechar}>
            {t("Cancelar")}
          </Button>
          <Button disabled={salvando} onClick={() => void criar()}>
            {salvando ? t("Salvando…") : t("Criar contato")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
