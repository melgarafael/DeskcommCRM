"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useTransition, useState } from "react";

import { useT } from "@/hooks/i18n/useT";
import {
  signupSchema,
  signupComConviteSchema,
  type SignupInput,
  type SignupComConviteInput,
} from "@/lib/auth/schemas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { signUp } from "@/app/actions/auth/signUp";

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

export function SignupForm({ convite }: { convite?: ConviteDoSignup }) {
  const t = useT();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [serverError, setServerError] = useState<string | null>(null);
  const [contaExistente, setContaExistente] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<SignupInput & { full_name: string }>({
    // O formulário tem UM tipo e DOIS contratos, e agora os dois contratos têm
    // um campo que o outro não tem: `org_name` só no caminho de quem abre
    // empresa, `full_name` só no de quem foi convidado. O resolver troca; o
    // tipo do form é a união larga dos dois, e cada campo só é renderizado —
    // e só é enviado — no modo a que pertence. O `as unknown as` existe porque
    // os dois contratos deixaram de se sobrepor o bastante para o TypeScript
    // aceitar a conversão direta.
    resolver: (convite
      ? zodResolver(signupComConviteSchema)
      : zodResolver(signupSchema)) as unknown as Resolver<SignupInput & { full_name: string }>,
    defaultValues: {
      full_name: "",
      org_name: "",
      email: convite?.email ?? "",
      password: "",
      password_confirm: "",
    },
  });

  const onSubmit = (values: SignupInput & { full_name: string }) => {
    setServerError(null);
    startTransition(async () => {
      // No modo convite o e-mail do formulário é readonly, e readonly no
      // cliente não vale nada: quem confere de novo é o servidor.
      const entrada: SignupInput | SignupComConviteInput = convite
        ? {
            full_name: values.full_name,
            email: convite.email,
            password: values.password,
            password_confirm: values.password_confirm,
          }
        : values;
      const res = await signUp(entrada, convite?.token);
      if (res.ok) {
        /**
         * ⚠️ O PROVEDOR JÁ DEIXOU A PESSOA ENTRAR — não existe e-mail para ela
         * esperar. Acontece quando "Confirm email" está desligado no provedor
         * de auth, que é uma escolha do operador da instalação e não um defeito
         * dele; o defeito é a tela abaixo, que manda "abra o e-mail e clique no
         * link" para quem já está autenticado. Sem este desvio a pessoa fica
         * parada nessa instrução para sempre: logada, sem organização, e sem
         * motivo nenhum para descobrir sozinha que a saída existe em
         * `/get-started`. Medido com um cliente real travado — achado de
         * @KIRAzinx566.
         *
         * O destino separa as duas naturezas de cadastro, com o dado que esta
         * tela já tem em mãos: quem veio de um convite vai ACEITAR o convite
         * (dar organização própria a essa pessoa é o erro que
         * `decidirConviteDoSignup` existe para evitar); quem se cadastrou por
         * conta própria vai à recuperação, que é o caminho auditado e com teto
         * de tentativas — e não uma segunda porta de provisionamento.
         */
        if (res.sessao_ativa) {
          router.replace(
            convite ? `/team/accept-invite/${convite.token}` : "/get-started",
          );
          return;
        }
        setSentTo(values.email);
        return;
      }
      if (res.error === "rate_limited") {
        setServerError(t("Muitas tentativas. Aguarde alguns minutos."));
      } else if (res.error === "validation_error") {
        setServerError(t("Dados inválidos. Confira os campos."));
      } else if (res.error === "conta_ja_existe" && convite) {
        // Ramo próprio porque o `else` mandava "Tente novamente" — e tentar de
        // novo nunca funciona quando a conta já existe. Em vez da mensagem,
        // a SAÍDA: entrar levando o convite pendurado, para cair no aceite e
        // não na tela inicial (que, para quem foi revogado, é a tela de acesso
        // revogado, com um botão Sair e mais nada).
        setContaExistente(true);
      } else {
        setServerError(t("Não foi possível criar a conta. Tente novamente."));
      }
    });
  };

  if (contaExistente && convite) {
    const destino = `/login?next=${encodeURIComponent(`/team/accept-invite/${convite.token}`)}`;
    return (
      <div className="space-y-4 rounded-md border bg-muted/40 px-4 py-6 text-center" role="status">
        <p className="text-sm font-medium">{t("Você já tem uma conta com este e-mail")}</p>
        <p className="text-sm text-muted-foreground">
          {t("Entre com ela para aceitar o convite — não é preciso criar outra.")}
        </p>
        <Button asChild className="w-full">
          <Link href={destino}>{t("Entrar e aceitar o convite")}</Link>
        </Button>
      </div>
    );
  }

  if (sentTo) {
    return (
      <div
        className="space-y-2 rounded-md border bg-muted/40 px-4 py-6 text-center"
        role="status"
      >
        <p className="text-sm font-medium">{t("Confirme seu e-mail")}</p>
        <p className="text-sm text-muted-foreground">
          {t("Enviamos um link de confirmação para")} <strong>{sentTo}</strong>.{" "}
          {t("Abra o e-mail e clique no link para ativar sua conta.")}
        </p>
      </div>
    );
  }

  return (
    <form method="post" onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
      {/*
        Só no modo CONVITE. Quem abre a própria empresa dá o nome no onboarding;
        quem é convidado pula o onboarding e ficava sem nome para sempre —
        aparecendo como um pedaço do identificador interno em toda tela que o
        nomeia (medido no diálogo de transferir conversa, em produção).
      */}
      {convite && (
      <div className="space-y-1.5">
        <Label htmlFor="full_name">{t("Seu nome")}</Label>
        <Input
          id="full_name"
          type="text"
          autoComplete="name"
          autoFocus
          aria-invalid={errors.full_name ? true : undefined}
          {...register("full_name")}
        />
        {errors.full_name && (
          <p className="text-xs text-destructive">{t(errors.full_name.message ?? "")}</p>
        )}
      </div>
      )}
      {!convite && (
      <div className="space-y-1.5">
        <Label htmlFor="org_name">{t("Nome da empresa")}</Label>
        <Input
          id="org_name"
          type="text"
          autoComplete="organization"
          autoFocus
          aria-invalid={errors.org_name ? true : undefined}
          {...register("org_name")}
        />
        {errors.org_name && (
          <p className="text-xs text-destructive">{t(errors.org_name.message ?? "")}</p>
        )}
      </div>
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
          <p className="text-xs text-destructive">{t(errors.email.message ?? "")}</p>
        )}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="password">{t("Senha")}</Label>
        <Input
          id="password"
          type="password"
          autoComplete="new-password"
          aria-invalid={errors.password ? true : undefined}
          {...register("password")}
        />
        {errors.password && (
          <p className="text-xs text-destructive">{t(errors.password.message ?? "")}</p>
        )}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="password_confirm">{t("Confirmar senha")}</Label>
        <Input
          id="password_confirm"
          type="password"
          autoComplete="new-password"
          aria-invalid={errors.password_confirm ? true : undefined}
          {...register("password_confirm")}
        />
        {errors.password_confirm && (
          <p className="text-xs text-destructive">{t(errors.password_confirm.message ?? "")}</p>
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
        {isPending ? t("Criando conta...") : t("Criar conta")}
      </Button>
    </form>
  );
}
