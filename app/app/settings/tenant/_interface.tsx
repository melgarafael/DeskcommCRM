"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { atualizarInterfaceDaEmpresa } from "@/app/actions/settings/atualizarInterfaceDaEmpresa";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { InterfaceEditor } from "@/components/team/InterfaceEditor";
import { useT } from "@/hooks/i18n/useT";
import type { Role } from "@/lib/auth/types";
import { lerInterface, type InterfaceSettings } from "@/lib/navigation/interface";

interface Props {
  /** O que está gravado hoje em `organizations.interface_settings`. */
  initial: unknown;
  /** Papel de quem edita: limita as opções ao que este papel enxerga. */
  role: Role;
}

/**
 * Editor do menu lateral da EMPRESA (issue #1341), em Configurações → Empresa.
 * Reusa o mesmo editor da escolha por vínculo de propósito: é a mesma pergunta
 * num nível acima, e duas telas com a mesma semântica divergem com o tempo.
 */
export function InterfaceDaEmpresaForm({ initial, role }: Props) {
  const t = useT();
  const [value, setValue] = useState<InterfaceSettings>(() => lerInterface(initial).settings);
  const [isPending, startTransition] = useTransition();

  function salvar() {
    startTransition(async () => {
      const resultado = await atualizarInterfaceDaEmpresa(value);
      if (resultado.ok) {
        toast.success(t("Menu lateral da empresa salvo."));
        return;
      }
      toast.error(t("Não foi possível salvar o menu da empresa."));
    });
  }

  return (
    <Card className="space-y-3 p-4">
      <h2 className="text-sm font-medium">{t("Menu lateral")}</h2>
      <p className="text-xs text-muted-foreground">
        {t(
          "Escolha as áreas que esta empresa mostra. Cada pessoa escolhe menos do que isto em Equipe — nunca mais — e as áreas essenciais continuam sempre visíveis. As permissões não mudam: o que o papel autoriza segue acessível por link, aviso e busca.",
        )}
      </p>
      <InterfaceEditor
        value={value}
        onChange={setValue}
        role={role}
        disabled={isPending}
      />
      <Button type="button" size="sm" disabled={isPending} onClick={salvar}>
        {t("Aplicar interface")}
      </Button>
    </Card>
  );
}
