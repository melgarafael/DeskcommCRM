import { requireAuth } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { normalizarIdioma } from "@/lib/i18n/idiomas";
import { SEM_PREFERENCIA_DE_IDIOMA } from "@/lib/schemas/settings";
import { ProfileForm } from "./_form";

export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const user = await requireAuth();
  // `locale` já vem tipado em AuthUser (loadAuthUser lê user_metadata.locale) —
  // o comentário antigo dizia que não vinha; estava desatualizado. `timezone`
  // não está em AuthUser e segue pelo cast do meta, como full_name/avatar_url.
  const meta = user as unknown as {
    full_name: string | null;
    avatar_url: string | null;
    timezone?: string | null;
  };
  // DOIS idiomas nesta tela, e confundi-los seria o defeito:
  //   `user.idioma`  → o que a interface está usando AGORA (já resolvido com a
  //                    organização). É com ele que esta página se traduz.
  //   `user.locale`  → a PREFERÊNCIA da pessoa, que pode estar vazia. É ela que
  //                    o formulário mostra, porque vazio significa "sigo minha
  //                    empresa" e o seletor tem uma opção para isso. Mostrar o
  //                    efetivo aqui faria quem salvasse sem mexer em nada gravar
  //                    uma preferência que ela nunca escolheu — e daí em diante
  //                    a troca de idioma da empresa passaria por cima dela.
  const idioma = user.idioma;
  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{traduzir("Perfil", idioma)}</h1>
        <p className="text-sm text-muted-foreground">
          {traduzir("Informações pessoais e credenciais de acesso.", idioma)}
        </p>
      </header>
      <ProfileForm
        email={user.email}
        initialFullName={meta.full_name}
        initialAvatarUrl={meta.avatar_url}
        initialLocale={user.locale ? normalizarIdioma(user.locale) : SEM_PREFERENCIA_DE_IDIOMA}
        initialTimezone={meta.timezone ?? "America/Sao_Paulo"}
      />
    </div>
  );
}
