"use client";

import { useState, useTransition } from "react";

import { updateSignupMode } from "@/app/actions/settings/updateSignupMode";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/hooks/i18n/useT";
import type { ModoDeCadastro } from "@/lib/auth/politica-de-cadastro";

/**
 * O interruptor salva na hora, sem botão de confirmar. É reversível com um
 * clique, e o registro de quem trocou (e de qual valor para qual) fica na
 * trilha de auditoria — que é onde a pergunta "por que ninguém mais consegue
 * criar conta?" é respondida.
 */
export function FormularioDeCadastro({ modoInicial }: { modoInicial: ModoDeCadastro }) {
  const t = useT();
  const [modo, setModo] = useState<ModoDeCadastro>(modoInicial);
  const [erro, setErro] = useState<string | null>(null);
  const [pendente, startTransition] = useTransition();

  function trocar(fechado: boolean) {
    const novo: ModoDeCadastro = fechado ? "so_convite" : "aberto";
    const anterior = modo;
    setErro(null);
    // Otimista, e com volta explícita no erro: sem a volta, uma falha de
    // gravação deixaria a tela dizendo "fechado" com o cadastro aberto — o
    // pior estado possível para uma configuração de acesso.
    setModo(novo);
    startTransition(async () => {
      const r = await updateSignupMode({ signup_mode: novo });
      if (!r.ok) {
        setModo(anterior);
        setErro(t("Não deu para salvar. Tente de novo em instantes."));
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Quem pode criar conta")}</CardTitle>
        <CardDescription>
          {t(
            "Vale para a instalação inteira, não para uma empresa só. Quem já tem conta continua entrando normalmente.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
          <div className="space-y-1">
            <Label htmlFor="so-convite" className="text-base">
              {t("Cadastro apenas por convite")}
            </Label>
            <p className="text-sm text-muted-foreground">
              {modo === "so_convite"
                ? t(
                    "Ligado: só entra quem recebeu um convite. Quem abrir a tela de cadastro sem convite vê um aviso e é levado ao login.",
                  )
                : t(
                    "Desligado: qualquer pessoa pode criar uma conta e abrir a própria empresa. É como o sistema sempre funcionou.",
                  )}
            </p>
          </div>
          <Switch
            id="so-convite"
            checked={modo === "so_convite"}
            onCheckedChange={trocar}
            disabled={pendente}
            aria-label={t("Cadastro apenas por convite")}
          />
        </div>

        {erro && (
          <p className="text-sm text-destructive" role="alert">
            {erro}
          </p>
        )}

        {modo === "so_convite" && (
          <p className="rounded-md border border-amber-300/60 bg-amber-50 px-4 py-3 text-sm dark:border-amber-500/30 dark:bg-amber-950/20">
            {t(
              "Com isto ligado, a única porta de entrada é o convite — inclusive para você, se um dia precisar de uma conta nova. Convide pela tela de Equipe antes de precisar.",
            )}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
