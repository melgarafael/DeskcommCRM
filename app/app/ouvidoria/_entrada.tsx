"use client";

/**
 * A CHAVE DA EMPRESA: receber manifestações ou não (#3611).
 *
 * Instalar o módulo cria a tabela; quem decide se ESTA empresa recebe relatos é
 * `settings.ouvidoria.ativa`, gravada por `definirOuvidoriaDaEmpresa`. Sem esta
 * chave na tela, a ação não tinha porta e a ouvidoria instalada nunca recebia
 * nada. Mesmo lugar da chave da lista de espera: a tela do próprio módulo.
 *
 * Desligar fecha só a entrada — a lista abaixo continua legível.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { definirOuvidoriaDaEmpresa } from "@/app/actions/settings/definir-ouvidoria";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/hooks/i18n/useT";

export function EntradaDaOuvidoria({ ligada }: { ligada: boolean }) {
  const t = useT();
  const router = useRouter();
  const [ativa, setAtiva] = useState(ligada);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState(false);

  async function trocar(proxima: boolean) {
    setSalvando(true);
    setErro(false);
    const resultado = await definirOuvidoriaDaEmpresa({ ativa: proxima });
    setSalvando(false);
    if (!resultado.ok) {
      setErro(true);
      return;
    }
    setAtiva(proxima);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Switch
          id="ouvidoria_ativa"
          checked={ativa}
          onCheckedChange={(v) => void trocar(v)}
          disabled={salvando}
        />
        <Label htmlFor="ouvidoria_ativa">{t("Receber manifestações nesta empresa")}</Label>
      </div>
      {erro && (
        <p role="alert" className="text-sm text-destructive">
          {t("Não foi possível salvar. Tente de novo.")}
        </p>
      )}
    </div>
  );
}
