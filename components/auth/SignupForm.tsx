"use client";

import { useForm, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useTransition, useState } from "react";

import {
  signupSchema,
  signupComConviteSchema,
  type SignupInput,
  type SignupComConviteInput,
} from "@/lib/auth/schemas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { signUp } from "@/app/actions/auth/signUp";
import { useBillingPlans } from "@/hooks/useBillingPlans";

function maskCnpj(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 14);
  if (digits.length <= 2) return digits;
  if (digits.length <= 5) return `${digits.slice(0, 2)}.${digits.slice(2)}`;
  if (digits.length <= 8) return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5)}`;
  if (digits.length <= 12)
    return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8)}`;
  return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8, 12)}-${digits.slice(12)}`;
}

/**
 * Convite em curso: a conta está sendo criada para ACEITAR um convite, não para
 * abrir uma empresa. Muda duas coisas na tela — some o campo "Nome da empresa"
 * (a empresa já existe; pedir seria mandar a pessoa batizar a organização de
 * outra gente) e o e-mail fica travado no do convite.
 */
export interface ConviteDoSignup {
  token: string;
  email: string;
}

export function SignupForm({
  convite,
  planId,
}: {
  convite?: ConviteDoSignup;
  /** Pré-seleciona o plano quando a pessoa vem de um link "Assinar X" da landing. */
  planId?: string;
}) {
  const [isPending, startTransition] = useTransition();
  const [serverError, setServerError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const { data: billingPlans } = useBillingPlans();

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
  } = useForm<SignupInput>({
    // O formulário tem UM tipo e DOIS contratos: no modo convite o campo de
    // empresa não é renderizado, e exigi-lo bloquearia o envio de um campo que
    // a pessoa não pode ver. O resolver troca; o tipo do form continua o largo,
    // e `org_name` simplesmente não é enviado ao servidor nesse modo.
    resolver: (convite
      ? zodResolver(signupComConviteSchema)
      : zodResolver(signupSchema)) as Resolver<SignupInput>,
    defaultValues: {
      org_name: "",
      email: convite?.email ?? "",
      password: "",
      password_confirm: "",
      plan_id: planId ?? "",
      cnpj: "",
    },
  });

  const onSubmit = (values: SignupInput) => {
    setServerError(null);
    startTransition(async () => {
      // No modo convite o e-mail do formulário é readonly, e readonly no
      // cliente não vale nada: quem confere de novo é o servidor.
      const entrada: SignupInput | SignupComConviteInput = convite
        ? { email: convite.email, password: values.password, password_confirm: values.password_confirm }
        : values;
      const res = await signUp(entrada, convite?.token);
      if (res.ok) {
        setSentTo(values.email);
        return;
      }
      if (res.error === "rate_limited") {
        setServerError("Muitas tentativas. Aguarde alguns minutos.");
      } else if (res.error === "validation_error") {
        setServerError("Dados inválidos. Confira os campos.");
      } else {
        setServerError("Não foi possível criar a conta. Tente novamente.");
      }
    });
  };

  if (sentTo) {
    return (
      <div
        className="space-y-2 rounded-md border bg-muted/40 px-4 py-6 text-center"
        role="status"
      >
        <p className="text-sm font-medium">Confirme seu e-mail</p>
        <p className="text-sm text-muted-foreground">
          Enviamos um link de confirmação para <strong>{sentTo}</strong>. Abra o
          e-mail e clique no link para ativar sua conta.
        </p>
      </div>
    );
  }

  return (
    <form method="post" onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
      {!convite && (
      <div className="space-y-1.5">
        <Label htmlFor="org_name">Nome da empresa</Label>
        <Input
          id="org_name"
          type="text"
          autoComplete="organization"
          autoFocus
          aria-invalid={errors.org_name ? true : undefined}
          {...register("org_name")}
        />
        {errors.org_name && (
          <p className="text-xs text-destructive">{errors.org_name.message}</p>
        )}
      </div>
      )}
      {/*
       * Plano de cobrança (Genesisia) — só aparece quando a instalação tem
       * algum billing_plans ativo. Self-host típico: lista vazia, bloco
       * inteiro não renderiza, ninguém vê seletor nenhum.
       */}
      {!convite && billingPlans && billingPlans.length > 0 && (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="plan_id">Plano</Label>
            <Select
              value={watch("plan_id") || undefined}
              onValueChange={(v) => setValue("plan_id", v, { shouldValidate: true })}
            >
              <SelectTrigger id="plan_id" aria-label="Plano">
                <SelectValue placeholder="Continuar sem assinatura" />
              </SelectTrigger>
              <SelectContent>
                {billingPlans.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name} —{" "}
                    {(p.price_cents / 100).toLocaleString("pt-BR", {
                      style: "currency",
                      currency: p.currency,
                    })}
                    /{p.billing_interval === "monthly" ? "mês" : "ano"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {watch("plan_id") ? (
            <div className="space-y-1.5">
              <Label htmlFor="cnpj">
                CNPJ <span className="text-destructive">*</span>
              </Label>
              <Input
                id="cnpj"
                placeholder="00.000.000/0000-00"
                inputMode="numeric"
                maxLength={18}
                aria-invalid={errors.cnpj ? true : undefined}
                {...register("cnpj")}
                onChange={(e) => setValue("cnpj", maskCnpj(e.target.value))}
              />
              <p className="text-xs text-muted-foreground">
                Necessário para emitir a cobrança do plano escolhido.
              </p>
              {errors.cnpj && <p className="text-xs text-destructive">{errors.cnpj.message}</p>}
            </div>
          ) : null}
        </>
      )}
      <div className="space-y-1.5">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          // O convite vale para UM endereço. Deixar editável convidaria a
          // trocar e receber "email_divergente" depois de preencher tudo.
          readOnly={Boolean(convite)}
          aria-invalid={errors.email ? true : undefined}
          {...register("email")}
        />
        {errors.email && (
          <p className="text-xs text-destructive">{errors.email.message}</p>
        )}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="password">Senha</Label>
        <Input
          id="password"
          type="password"
          autoComplete="new-password"
          aria-invalid={errors.password ? true : undefined}
          {...register("password")}
        />
        {errors.password && (
          <p className="text-xs text-destructive">{errors.password.message}</p>
        )}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="password_confirm">Confirmar senha</Label>
        <Input
          id="password_confirm"
          type="password"
          autoComplete="new-password"
          aria-invalid={errors.password_confirm ? true : undefined}
          {...register("password_confirm")}
        />
        {errors.password_confirm && (
          <p className="text-xs text-destructive">{errors.password_confirm.message}</p>
        )}
      </div>
      {serverError && (
        <div
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          {serverError}
        </div>
      )}
      <Button type="submit" className="w-full" disabled={isPending}>
        {isPending ? "Criando conta..." : "Criar conta"}
      </Button>
    </form>
  );
}
