import { normalizarIdioma } from "@/lib/i18n/idiomas";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Entrar" };

const ERROS_SSO: Record<string, string> = {
  sso_invalido: "Não foi possível validar este acesso. Entre novamente pelo Advomax.",
  sso_expirado: "O acesso expirou. Entre novamente pelo Advomax.",
  sso_indisponivel: "O login integrado está temporariamente indisponível.",
  sso_identidade: "Este usuário já está associado a outra identidade.",
  sso_convite: "Seu usuário ainda não foi liberado para este CRM.",
  sso_organizacao: "Não foi possível vincular o escritório ao CRM.",
  sso_membership: "Não foi possível liberar seu acesso ao escritório.",
  sso_sessao: "Não foi possível concluir sua sessão no CRM.",
  sso_provisionamento: "Não foi possível preparar o CRM do seu escritório.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const idioma = normalizarIdioma(
    (user?.user_metadata?.locale as string | undefined) ?? null,
  );
  const t = (texto: string) => traduzir(texto, idioma);
  const mensagemErro = error ? ERROS_SSO[error] : null;

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <h2 className="text-[32px] font-bold tracking-[-.035em] text-[#071b33]">
          Bem-vindo ao CRM
        </h2>
        <p className="leading-6 text-[#6b7788]">
          Use a mesma conta do Advomax para acessar o CRM do seu escritório.
        </p>
      </div>
      {mensagemErro && (
        <div
          className="rounded-xl border border-[#dca79f] bg-[#fff5f3] px-4 py-3 text-sm leading-6 text-[#8a3a2e]"
          role="alert"
        >
          {t(mensagemErro)}
        </div>
      )}
      <a
        href="/auth/advomax/start"
        className="flex min-h-12 w-full items-center justify-center rounded-xl bg-[#071b33] px-5 text-sm font-bold text-[#f8fafc] shadow-[0_12px_24px_rgba(7,27,51,.18)] transition-[transform,background-color] duration-200 hover:-translate-y-0.5 hover:bg-[#102a4b] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#071b33] focus-visible:ring-offset-2"
      >
        {t("Entrar com minha conta Advomax")}
      </a>
      <p className="border-t border-[#edf0f4] pt-6 text-[13px] leading-5 text-[#718096]">
        O login, os usuários e as permissões continuam sendo gerenciados no Advomax.
      </p>
    </div>
  );
}
