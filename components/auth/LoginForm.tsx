"use client";

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useTransition, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

import { useT } from "@/hooks/i18n/useT";
import { loginSchema, type LoginInput } from "@/lib/auth/schemas";
import { Label } from "@/components/ui/label";
import { signInWithPassword } from "@/app/actions/auth/signInWithPassword";

/**
 * ── Por que `<input>` cru, e não `components/ui/input.tsx` ────────────────────
 *
 * No desenho a BORDA e o FUNDO são da caixa que contém o ícone e o campo, não do
 * campo: o ícone fica DENTRO da moldura, e o cursor de texto pega a largura toda.
 * O `<Input>` do design system desenha a borda em si mesmo — usá-lo aqui daria
 * duas molduras aninhadas, e desmontar a dele por `className` seria escrever
 * `border-none bg-transparent` justamente por cima do que ele existe para dar.
 *
 * O foco não se perdeu nisso: `focus-within` na moldura reproduz o anel do design
 * system (`focus-visible:border-accent-500`) na camada que agora desenha a borda.
 */
const MOLDURA =
  "flex h-[50px] items-center gap-2.5 border bg-[#10131C] transition-colors duration-fast ease-out " +
  "focus-within:border-accent-500";
const CAMPO =
  "h-full min-w-0 flex-1 border-none bg-transparent text-[15px] text-text outline-none " +
  "placeholder:text-text/50";

export function LoginForm({ next }: { next?: string }) {
  const t = useT();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [serverError, setServerError] = useState<string | null>(null);
  const [senhaVisivel, setSenhaVisivel] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  });

  const onSubmit = (values: LoginInput) => {
    setServerError(null);
    startTransition(async () => {
      // Server Action redirects on success — no return value reaches here.
      // On failure, an error discriminator is returned and rendered inline.
      const res = await signInWithPassword(values, next);
      if (!res) {
        // Should be unreachable (redirect throws), but guard anyway.
        router.replace(next || "/app/inbox");
        return;
      }
      if (res.error === "mfa_required") {
        const params = new URLSearchParams();
        if (next) params.set("next", next);
        if (res.challengeId) params.set("factor", res.challengeId);
        router.replace(`/login/mfa${params.toString() ? `?${params}` : ""}`);
        return;
      }
      if (res.error === "invalid_credentials") {
        setServerError(t("Email ou senha incorretos."));
      } else if (res.error === "rate_limited") {
        setServerError(t("Muitas tentativas. Aguarde alguns minutos."));
      } else if (res.error === "validation_error") {
        setServerError(t("Dados inválidos. Confira os campos."));
      } else {
        setServerError(t("Erro inesperado. Tente novamente."));
      }
    });
  };

  return (
    <form
      method="post"
      onSubmit={handleSubmit(onSubmit)}
      className="mt-[34px] flex flex-col gap-[18px]"
      noValidate
    >
      <div className="flex flex-col gap-[7px]">
        <Label htmlFor="email" className="text-[13px] font-medium text-text/[0.82]">
          {t("E-mail")}
        </Label>
        <div
          className={`${MOLDURA} px-3.5 ${errors.email ? "border-error" : "border-text/[0.16]"}`}
        >
          <svg
            width="17"
            height="17"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="flex-none text-text/[0.55]"
          >
            <rect x="2" y="4" width="20" height="16" />
            <path d="m2 6 10 7 10-7" />
          </svg>
          <input
            id="email"
            type="email"
            autoComplete="email"
            autoFocus
            placeholder={t("voce@empresa.com.br")}
            aria-invalid={errors.email ? true : undefined}
            className={CAMPO}
            {...register("email")}
          />
        </div>
        {errors.email && (
          <p className="text-xs text-error-fg">{t(errors.email.message ?? "")}</p>
        )}
      </div>

      <div className="flex flex-col gap-[7px]">
        <Label htmlFor="password" className="text-[13px] font-medium text-text/[0.82]">
          {t("Senha")}
        </Label>
        <div
          className={`${MOLDURA} py-0 pl-3.5 pr-2 ${errors.password ? "border-error" : "border-text/[0.16]"}`}
        >
          <svg
            width="17"
            height="17"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="flex-none text-text/[0.55]"
          >
            <rect x="3" y="11" width="18" height="10" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
          <input
            id="password"
            type={senhaVisivel ? "text" : "password"}
            autoComplete="current-password"
            placeholder={t("Digite sua senha")}
            aria-invalid={errors.password ? true : undefined}
            className={CAMPO}
            {...register("password")}
          />
          {/*
            `aria-pressed` + rótulo que MUDA: quem usa leitor de tela precisa
            saber em que estado o botão deixou o campo, e um rótulo fixo
            ("Mostrar senha") mentiria metade do tempo.
          */}
          <button
            type="button"
            onClick={() => setSenhaVisivel((v) => !v)}
            aria-pressed={senhaVisivel}
            aria-label={senhaVisivel ? t("Ocultar senha") : t("Mostrar senha")}
            className="flex h-[34px] w-[34px] flex-none items-center justify-center text-text/[0.55] transition-colors duration-fast ease-out hover:bg-text/[0.08] hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
          >
            {senhaVisivel ? (
              <svg
                width="17"
                height="17"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M10.7 5.1A9.9 9.9 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2M6.6 6.6A17.6 17.6 0 0 0 2 12s3.6 7 10 7a9.9 9.9 0 0 0 4.2-.9" />
                <path d="M9.9 9.9a3 3 0 1 0 4.2 4.2" />
                <path d="m2 2 20 20" />
              </svg>
            ) : (
              <svg
                width="17"
                height="17"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            )}
          </button>
        </div>
        {errors.password && (
          <p className="text-xs text-error-fg">{t(errors.password.message ?? "")}</p>
        )}
      </div>

      {/*
        A maquete punha "Manter conectado" à esquerda deste link, e a caixa saiu
        daqui: ligá-la de verdade mexe na duração da sessão
        (`signInWithPassword` / Supabase), que é outra tarefa. Uma caixa que não
        faz nada é pior que caixa nenhuma — a pessoa marca, o efeito não existe,
        e ela descobre sendo deslogada no dia seguinte.
        Quando a sessão longa virar tarefa, a caixa volta para cá, à esquerda do
        link, e o `justify-end` volta a ser `justify-between`.
      */}
      <div className="-mt-1 flex items-center justify-end">
        <Link
          href="/login/forgot"
          className="text-[13px] font-medium text-accent-500 underline-offset-4 hover:underline"
        >
          {t("Esqueci minha senha")}
        </Link>
      </div>

      {serverError && (
        <div
          className="border border-error/40 bg-error-bg px-3 py-2 text-sm text-error-fg"
          role="alert"
        >
          {serverError}
        </div>
      )}

      <button
        type="submit"
        disabled={isPending}
        className="mt-2 h-14 w-full bg-accent text-[16.5px] font-semibold tracking-[0.01em] text-accent-foreground transition-colors duration-base ease-out hover:bg-[#2A55AE] active:bg-[#22458F] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isPending ? t("Entrando...") : t("Entrar")}
      </button>
    </form>
  );
}
