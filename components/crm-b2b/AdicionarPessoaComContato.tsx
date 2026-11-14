"use client";

import { useState } from "react";

import { mensagemDeErro } from "@/components/crm-b2b/BuscarEEscolher";
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
import { useT } from "@/hooks/i18n/useT";

interface Props {
  empresaId: string;
  aberto: boolean;
  onAbertoChange: (aberto: boolean) => void;
  /** Chamado depois de gravar, para a página da empresa recarregar a lista. */
  onSalvo: () => void;
}

const VAZIO = { nome: "", cargo: "", decisor: false, telefone: "", email: "" };

/**
 * Cadastro seguido: uma pessoa nova com o contato dela (telefone/e-mail), já
 * ligada à empresa. Uma chamada só (`POST /api/v1/companies/:id/contatos`):
 * o servidor cria pessoa, contato e vínculos, e desfaz tudo se algo falhar.
 */
export function AdicionarPessoaComContato({ empresaId, aberto, onAbertoChange, onSalvo }: Props) {
  const t = useT();
  const [campos, setCampos] = useState(VAZIO);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  function fechar() {
    setCampos(VAZIO);
    setErro(null);
    onAbertoChange(false);
  }

  async function salvar() {
    setSalvando(true);
    setErro(null);
    try {
      const res = await fetch(`/api/v1/companies/${empresaId}/contatos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          full_name: campos.nome.trim(),
          job_title: campos.cargo.trim() || null,
          is_decision_maker: campos.decisor,
          phone_number: campos.telefone.trim() || undefined,
          email: campos.email.trim() || undefined,
        }),
      });
      const falha = await mensagemDeErro(res, t("Não foi possível salvar."));
      if (falha) {
        setErro(falha);
        return;
      }
      onSalvo();
      fechar();
    } finally {
      setSalvando(false);
    }
  }

  return (
    <Dialog open={aberto} onOpenChange={(a) => (a ? onAbertoChange(true) : fechar())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Adicionar pessoa com contato")}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="pc-nome">{t("Nome")}</Label>
            <Input
              id="pc-nome"
              value={campos.nome}
              maxLength={300}
              onChange={(e) => setCampos({ ...campos, nome: e.target.value })}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="pc-cargo">{t("Cargo")}</Label>
            <Input
              id="pc-cargo"
              value={campos.cargo}
              maxLength={200}
              onChange={(e) => setCampos({ ...campos, cargo: e.target.value })}
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={campos.decisor}
              onChange={(e) => setCampos({ ...campos, decisor: e.target.checked })}
            />
            {t("É decisor")}
          </label>
          <div className="grid gap-1.5">
            <Label htmlFor="pc-telefone">{t("Telefone / WhatsApp")}</Label>
            <Input
              id="pc-telefone"
              inputMode="tel"
              placeholder="(11) 99999-8888"
              value={campos.telefone}
              onChange={(e) => setCampos({ ...campos, telefone: e.target.value })}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="pc-email">{t("E-mail")}</Label>
            <Input
              id="pc-email"
              type="email"
              value={campos.email}
              onChange={(e) => setCampos({ ...campos, email: e.target.value })}
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
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={fechar}>
            {t("Cancelar")}
          </Button>
          <Button onClick={() => void salvar()} disabled={salvando || !campos.nome.trim()}>
            {salvando ? t("Salvando…") : t("Salvar")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
