"use client";

import { Card } from "@/components/ui/card";
import { useT } from "@/hooks/i18n/useT";

/**
 * "IA COPIADA DO MOLDE" — o efeito do gatilho `fn_molde_de_ia_na_org_nova`
 * (migration 9096), lido da auditoria DESTA empresa (`ai.molde_de_ia_aplicado`).
 *
 * Sem este cartão, a única pista de que a empresa nasceu com a IA de outra era
 * abrir Agente de IA › Provedores e reconhecer os modelos — e "por que esta
 * empresa já veio com Haiku no classificador?" ficaria sem resposta na tela de
 * quem administra o servidor. A linha da auditoria é a fonte; o cartão só a
 * mostra.
 */
export interface IaDoMolde {
  /** `null` = o molde já foi excluído; a linha da auditoria continua dizendo que houve cópia. */
  readonly nomeDoMolde: string | null;
  readonly funcoes: number;
  readonly padrao: string | null;
  /** Já formatado pelo servidor, com fuso fixo — mesmo motivo de `/admin/sistema`. */
  readonly quando: string;
}

const EMPRESA = "{empresa}";
const N = "{n}";

export function CartaoDaIaDoMolde({ ia }: { ia: IaDoMolde }) {
  const t = useT();
  return (
    <Card className="space-y-2 p-5" data-testid="ia-do-molde">
      <h2 className="text-base font-semibold">{t("IA copiada do molde")}</h2>
      <p className="text-sm">
        {ia.nomeDoMolde
          ? t("Esta empresa nasceu com a IA de {empresa}.").replace(EMPRESA, ia.nomeDoMolde)
          : t("Esta empresa nasceu com a IA de uma empresa que já foi excluída.")}{" "}
        <span className="text-muted-foreground">{ia.quando}</span>
      </p>
      <p className="text-sm text-muted-foreground">
        {ia.funcoes === 1
          ? t("1 função de IA copiada")
          : t("{n} funções de IA copiadas").replace(N, String(ia.funcoes))}
        {ia.padrao ? (
          <>
            {" · "}
            {t("Modelo padrão:")} <span className="font-mono">{ia.padrao}</span>
          </>
        ) : null}
      </p>
      <p className="text-xs text-muted-foreground">
        {t("Depois de nascer, a IA é desta empresa: trocar o molde não muda o que ela já tem.")}
      </p>
    </Card>
  );
}
