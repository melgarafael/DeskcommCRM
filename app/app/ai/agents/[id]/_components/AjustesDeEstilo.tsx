"use client";

import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/hooks/i18n/useT";
import { useSetStyleAdjustment, useStyleAdjustments } from "@/hooks/ai/useStyleAdjustments";

/**
 * Configuração da ORGANIZAÇÃO, embora apareça junto do papel de segurança do
 * agente: todos os agentes publicados passam pela mesma borda de envio.
 *
 * O texto visível reaproveita chaves já traduzidas da própria tela. O item em si
 * é deliberadamente simbólico (`— → ,`): a regra fechada fica legível em PT e ES
 * sem criar uma linguagem de localizar/substituir livre.
 */
export function AjustesDeEstilo() {
  const t = useT();
  const consulta = useStyleAdjustments();
  const gravar = useSetStyleAdjustment();
  // `?.ajustes?.find`: enquanto a consulta não volta, `data` existe sem `ajustes`
  // no cache de outra chave, e o `.find` direto estourava a tela inteira
  // (medido em tests/unit/painel-de-seguranca.test.tsx, 3 casos).
  const atual = consulta.data?.ajustes?.find((item) => item.ajuste === "sem_travessao_longo");
  const ligado = atual?.enabled ?? false;
  const podeEditar = consulta.data?.podeEditar ?? false;

  return (
    <Card className="space-y-2 p-4" data-testid="ajustes-de-estilo">
      <h3 className="text-sm font-medium">{t("Estilo de resposta")}</h3>
      <p className="text-xs text-muted-foreground">{t("Antes de cada mensagem sair")}</p>
      <div className="flex items-center gap-3">
        <Switch
          data-testid="ajuste-sem-travessao-longo"
          checked={ligado}
          disabled={!podeEditar || consulta.isLoading || gravar.isPending}
          onCheckedChange={(enabled) =>
            gravar.mutate({ ajuste: "sem_travessao_longo", enabled })
          }
          aria-label="— → ,"
        />
        <code className="rounded-md bg-muted px-2 py-1 text-xs">— → ,</code>
        <span className="text-xs text-muted-foreground">
          {consulta.isLoading
            ? t("carregando…")
            : ligado
              ? t("Ligada por você")
              : t("Desligada por você")}
        </span>
      </div>
    </Card>
  );
}
