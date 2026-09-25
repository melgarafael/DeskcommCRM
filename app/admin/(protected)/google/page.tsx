import { notFound } from "next/navigation";
import { headers } from "next/headers";

import { configuracaoDoAmbiente, enderecoDeRetorno, origemLocalDosCabecalhos } from "@/lib/agenda/google/config";
import { loadAuthUser } from "@/lib/auth/server";
import { tagDeIdioma } from "@/lib/i18n/datas";
import { createAdminClient } from "@/lib/supabase/admin";

import { FormularioDoGoogle } from "./_form";

export const metadata = { title: "Google Agenda da instalação" };
export const dynamic = "force-dynamic";

/**
 * A tela onde o dono da instalação cadastra o app OAuth do Google.
 *
 * ── O defeito que ela fecha ──────────────────────────────────────────────────
 *
 * O cartão da Agenda dizia: "Esta instalação não tem as credenciais do Google
 * cadastradas — quem instalou o sistema precisa configurar
 * GOOGLE_CALENDAR_CLIENT_ID e GOOGLE_CALENDAR_CLIENT_SECRET". O produto é
 * self-host para quem NÃO programa: nomear variáveis de ambiente para essa
 * pessoa é o mesmo que dizer que a funcionalidade não existe. Configurar exigia
 * SSH na VPS, um editor de texto e recriar o contêiner.
 *
 * ── Por que `/admin`, e não `/app/settings` ──────────────────────────────────
 *
 * O objeto é a INSTALAÇÃO, não a organização: o `redirect_uri` sai de
 * `NEXT_PUBLIC_APP_URL` e o app OAuth é registrado no console do Google por quem
 * instalou. Num revendedor que hospeda várias empresas, deixar o admin de um
 * tenant trocar isso derrubaria a conexão do Google de TODOS. É o mesmo
 * argumento de `/admin/marca`, e esta tela é irmã dela.
 *
 * ── Por que `notFound()`, e não `redirect('/403')` ───────────────────────────
 *
 * Para quem não administra a instalação, esta tela simplesmente não faz parte do
 * produto — a existência dela não é assunto dele. O layout de `(protected)` já
 * roda `requirePlatformAdmin()`, então o gate abaixo é redundante HOJE; ele fica
 * porque a garantia precisa ser local, e um layout pode ser movido.
 *
 * ⚠️ O SEGREDO NÃO VOLTA. A leitura pede `client_id` e um booleano — nunca o
 * `client_secret_encrypted`, nem decifrado. Devolvê-lo para preencher o campo o
 * vazaria a cada render, para qualquer XSS, para o payload do RSC e para o cache
 * do navegador. Ele é o que permite trocar códigos e refresh tokens em nome
 * desta instalação, isto é, ler a agenda de todos os atendentes que conectaram.
 */
export default async function Page() {
  const usuario = await loadAuthUser();
  if (!usuario?.is_platform_admin) notFound();
  const cabecalhos = await headers();
  const origemLocal = origemLocalDosCabecalhos(cabecalhos);

  // A tabela é server-side only (RLS ligada, zero policies, grants revogados de
  // anon/authenticated), então o admin client é o único caminho — como em
  // `platform_branding`.
  const { data } = await createAdminClient()
    .from("platform_google_oauth")
    .select("client_id, client_secret_encrypted, updated_at")
    .eq("id", 1)
    .maybeSingle();

  const linha = data as
    | { client_id: string | null; client_secret_encrypted: string | null; updated_at: string | null }
    | null;

  // O que o `.env` traz, para a tela poder dizer de ONDE vem o que está em
  // vigor. Sem isso, quem tem o par no `.env` e abre esta tela vazia conclui que
  // não há nada configurado — e a precedência (banco primeiro) fica invisível.
  const doAmbiente = configuracaoDoAmbiente();

  return (
    <FormularioDoGoogle
      clientIdSalvo={linha?.client_id ?? null}
      temSegredoSalvo={Boolean(linha?.client_secret_encrypted)}
      atualizadoEm={
        linha?.updated_at
          ? new Date(linha.updated_at).toLocaleString(tagDeIdioma(usuario.idioma), {
              // Fuso fixo porque a coluna é da INSTALAÇÃO: não há organização
              // resolvida nesta tela de onde tirar um, e formatar no cliente
              // faria o HTML servido e a hidratação divergirem.
              timeZone: "America/Sao_Paulo",
              dateStyle: "short",
              timeStyle: "short",
            })
          : null
      }
      temNoAmbiente={doAmbiente !== null}
      enderecoDeRetorno={enderecoDeRetorno(origemLocal ?? undefined)}
    />
  );
}
