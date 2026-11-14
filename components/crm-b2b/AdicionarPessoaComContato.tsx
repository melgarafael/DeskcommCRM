"use client";

import { useState } from "react";

import { FormPessoaComContato } from "@/components/crm-b2b/FormPessoaComContato";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useT } from "@/hooks/i18n/useT";

interface Props {
  empresaId: string;
  aberto: boolean;
  onAbertoChange: (aberto: boolean) => void;
  /** Chamado depois de gravar, para a página da empresa recarregar a lista. */
  onSalvo: () => void;
}

/** "Adicionar pessoa com contato" na página da empresa: o formulário num diálogo. */
export function AdicionarPessoaComContato({ empresaId, aberto, onAbertoChange, onSalvo }: Props) {
  const t = useT();
  const [salvando, setSalvando] = useState(false);

  return (
    <Dialog open={aberto} onOpenChange={(a) => (a || !salvando) && onAbertoChange(a)}>
      <DialogContent onEscapeKeyDown={(e) => salvando && e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{t("Adicionar pessoa com contato")}</DialogTitle>
        </DialogHeader>
        {/* Monta só aberto: o estado (campos, erro) morre ao fechar. */}
        <FormPessoaComContato
          empresaId={empresaId}
          rotuloSecundario={t("Cancelar")}
          onSecundario={() => onAbertoChange(false)}
          onSalvandoChange={setSalvando}
          onSalvo={() => {
            onSalvo();
            onAbertoChange(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
