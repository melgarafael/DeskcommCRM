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
import { mensagemDeErro } from "@/components/crm-b2b/BuscarEEscolher";
import { CamposDoVinculo, VINCULO_VAZIO, type Vinculo } from "@/components/crm-b2b/CamposDoVinculo";
import { useT } from "@/hooks/i18n/useT";

/** O vínculo que se edita: a linha de `company_people` e o nome que aparece no título. */
export interface VinculoEmEdicao {
  id: string;
  nome: string;
  job_title: string | null;
  is_decision_maker: boolean;
}

/**
 * Corrigir cargo e decisor de um vínculo pessoa ↔ empresa já feito (issue
 * #3198) — antes, o único jeito era remover e ligar de novo. Usa o PATCH
 * company-people/:id que já existia (piso `agent`).
 */
export function EditarVinculo({
  vinculo,
  onFechar,
  onSalvo,
}: {
  vinculo: VinculoEmEdicao | null;
  onFechar: () => void;
  onSalvo: () => void;
}) {
  const t = useT();
  // Quem usa monta com `key` = id do vínculo: cada abertura começa do valor salvo.
  const [valor, setValor] = useState<Vinculo>(() =>
    vinculo
      ? { job_title: vinculo.job_title ?? "", is_decision_maker: vinculo.is_decision_maker }
      : VINCULO_VAZIO,
  );
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  async function salvar() {
    if (!vinculo) return;
    setSalvando(true);
    setErro(null);
    const res = await fetch(`/api/v1/company-people/${vinculo.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        job_title: valor.job_title.trim() || null,
        is_decision_maker: valor.is_decision_maker,
      }),
    });
    const falha = await mensagemDeErro(res, t("Não foi possível salvar."));
    setSalvando(false);
    if (falha) {
      setErro(falha);
      return;
    }
    onSalvo();
    onFechar();
  }

  return (
    <Dialog open={Boolean(vinculo)} onOpenChange={(a) => (a ? null : onFechar())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t("Editar vínculo")}
            {vinculo ? `: ${vinculo.nome}` : ""}
          </DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 py-1">
          <CamposDoVinculo valor={valor} onChange={setValor} />
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
          <Button disabled={salvando} onClick={() => void salvar()}>
            {salvando ? t("Salvando…") : t("Salvar")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
