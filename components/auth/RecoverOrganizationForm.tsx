"use client";

import { useState } from "react";

import { useT } from "@/hooks/i18n/useT";
import { recoverOrganization } from "@/app/actions/auth/recoverOrganization";
import { AvisoSemResposta, useEnvioComTeto } from "@/components/auth/teto-da-espera";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { PlanoDoCadastro } from "@/lib/cobranca/cadastro";

/**
 * As frases em português são as CHAVES do dicionário — a mesma convenção do
 * resto da casa (`lib/i18n/dicionario.ts`). Passar por `t()` na hora de exibir é
 * o que separa "acrescentei um idioma" de "mudei a tela de quem já usava".
 */
const MENSAGENS: Record<string, string> = {
  validation_error: "Informe um nome de empresa com 2 a 120 caracteres.",
  rate_limited: "Muitas tentativas. Aguarde alguns minutos antes de tentar novamente.",
  invite_pending:
    "Esta conta tem um convite pendente ou inválido. Use o link do convite ou peça um novo ao administrador.",
  somente_convite:
    "Esta instalação aceita cadastro apenas por convite. Peça um convite a quem administra o sistema.",
  provision_failed:
    "Não foi possível concluir a organização agora. Tente novamente ou contate o administrador da instalação.",
  // Diz a verdade sobre o que aconteceu. Antes, quem tinha o acesso revogado
  // recebia a frase de `invite_pending` — por acaso, porque o convite ainda
  // estava no `user_metadata` — e ia procurar um link de convite que não
  // resolveria nada.
  access_revoked:
    "Seu acesso a esta organização foi retirado. Fale com quem administra a empresa — criar uma organização nova não devolve o acesso.",
  pedido_recusado:
    "Quem administra esta instalação não aprovou o pedido. Se você recebeu um convite, use o link que chegou no seu e-mail.",
  plano_obrigatorio: "Escolha um plano para criar a empresa.",
};

/**
 * `nomeSugerido` é o nome de empresa que a pessoa digitou no CADASTRO e que
 * viajou até aqui pelo `user_metadata` — o mesmo canal que `/auth/confirm` usa
 * para provisionar. Ele só semeia o campo: quem valida continua sendo o Zod da
 * action, e a pessoa pode trocar antes de enviar. Sem isto, quem cai na
 * recuperação precisa digitar de novo um dado que o sistema já tem, no momento
 * em que ela está mais propensa a desistir.
 */
export function RecoverOrganizationForm({
  nomeSugerido,
  comAprovacao = false,
  planos = [],
  planoInicial,
}: {
  nomeSugerido?: string;
  /** Instalação em `com_aprovacao`: o envio vira pedido, e o botão diz isso. */
  comAprovacao?: boolean;
  /** Planos oferecidos no cadastro (#2846): com eles, a empresa nasce no escolhido. */
  planos?: readonly PlanoDoCadastro[];
  planoInicial?: string;
}) {
  const t = useT();
  const [name, setName] = useState(nomeSugerido ?? "");
  const [plano, setPlano] = useState(planoInicial ?? "");
  const [error, setError] = useState<string | null>(null);
  const { pendente: isPending, semResposta, enviar } = useEnvioComTeto();

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    // O caminho de sucesso não volta: a action redireciona (onboarding, ou a
    // própria tela mostrando o pedido enviado).
    void enviar(
      () => recoverOrganization(name, plano || undefined),
      (result) => {
        if (!result.ok) setError(t(MENSAGENS[result.error] ?? MENSAGENS.provision_failed!));
      },
    );
  }

  return (
    <form method="post" className="space-y-4" onSubmit={submit} noValidate>
      <div className="space-y-1.5">
        <Label htmlFor="recovery-org-name">{t("Nome da empresa")}</Label>
        <Input
          id="recovery-org-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoComplete="organization"
          autoFocus
          disabled={isPending}
          aria-invalid={Boolean(error)}
        />
      </div>
      {planos.length > 0 && (
        <div className="space-y-1.5">
          <Label htmlFor="recovery-plano">{t("Plano")}</Label>
          <select
            id="recovery-plano"
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            value={plano}
            onChange={(event) => setPlano(event.target.value)}
            disabled={isPending}
          >
            {planos.map((p) => (
              <option key={p.id} value={p.id}>
                {p.nome} — {new Intl.NumberFormat(undefined, { style: "currency", currency: "BRL" }).format(p.preco_cents / 100)} / {p.intervalo === "ano" ? t("ano") : t("mês")}
                {p.trial_dias > 0 ? ` · ${p.trial_dias} ${t("dias de teste")}` : ` · ${t("sem período de teste")}`}
              </option>
            ))}
          </select>
        </div>
      )}
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      {semResposta && <AvisoSemResposta />}
      <Button className="w-full" type="submit" disabled={isPending || name.trim().length < 2}>
        {isPending
          ? t("Preparando seu ambiente…")
          : comAprovacao
            ? t("Enviar pedido")
            : t("Continuar para o onboarding")}
      </Button>
    </form>
  );
}
