import { notFound } from "next/navigation";

import { loadAuthUser } from "@/lib/auth/server";
import { appDaMetaDoAmbiente } from "@/lib/channels/meta/app";
import { tagDeIdioma } from "@/lib/i18n/datas";
import type { Idioma } from "@/lib/i18n/idiomas";
import { createAdminClient } from "@/lib/supabase/admin";

import { FormularioDaMeta } from "./_form";

export const metadata = { title: "API Oficial da Meta da instalação" };
export const dynamic = "force-dynamic";

/**
 * A tela onde o dono da instalação cadastra o App da Meta — a chave secreta que
 * confere cada entrega do webhook e o token de verificação do handshake.
 *
 * ── O defeito que ela fecha ──────────────────────────────────────────────────
 *
 * A migration 0257 criou `platform_meta_app` e a server action que a grava, mas
 * nenhuma tela a chamava: a tabela só se preenchia por SQL, e a promessa de
 * "token gerado pelo servidor e mostrado uma vez" não tinha onde acontecer. Para
 * quem NÃO programa, isso é o mesmo que o `.env` de antes (issue #850).
 *
 * ── Por que `/admin`, e não `/app/settings` ──────────────────────────────────
 *
 * O objeto é a INSTALAÇÃO: um app da Meta atende os números de todas as empresas
 * desta VPS. Deixar o admin de um tenant trocá-lo derrubaria a entrada de
 * mensagens de TODOS. Irmã de `/admin/google`, que é o molde.
 *
 * ── Por que `notFound()` ─────────────────────────────────────────────────────
 *
 * Mesma decisão, mesma frase, de `/admin/google`: o layout de `(protected)` já
 * roda `requirePlatformAdmin()`, e o gate local fica porque um layout pode ser
 * movido.
 *
 * ⚠️ NENHUM SEGREDO VAI AO CLIENTE — nem cifrado. A leitura abaixo traz as
 * colunas cifradas só para saber SE existem; o que atravessa a fronteira são
 * booleanos e datas. O token em claro sai do servidor numa única resposta: a da
 * server action que acabou de gerá-lo. Não há leitura que o devolva, e esta
 * página não decifra nada. Vigiado em
 * `tests/unit/app-da-meta-tela-nao-devolve-segredo.test.tsx`.
 */
export default async function Page() {
  const usuario = await loadAuthUser();
  if (!usuario?.is_platform_admin) notFound();

  // Server-side only (RLS ligada, zero policies, grants revogados de
  // anon/authenticated): o admin client é o único caminho.
  const { data, error } = await createAdminClient()
    .from("platform_meta_app")
    .select("app_secret_encrypted, verify_token_encrypted, verify_token_created_at, updated_at")
    .eq("id", 1)
    .maybeSingle();

  const linha = data as
    | {
        app_secret_encrypted: string | null;
        verify_token_encrypted: string | null;
        verify_token_created_at: string | null;
        updated_at: string | null;
      }
    | null;

  // O `.env` é o piso de rollback (`lib/channels/meta/app.ts`). Dizer que ele
  // existe é o que torna a precedência visível: sem isto, quem tem o par no
  // arquivo abre a tela vazia e conclui que o canal oficial não recebe nada.
  const doAmbiente = appDaMetaDoAmbiente();

  return (
    <FormularioDaMeta
      temSegredoSalvo={Boolean(linha?.app_secret_encrypted)}
      temTokenSalvo={Boolean(linha?.verify_token_encrypted)}
      tokenGeradoEm={formatar(linha?.verify_token_created_at ?? null, usuario.idioma)}
      atualizadoEm={formatar(linha?.updated_at ?? null, usuario.idioma)}
      temNoAmbiente={Boolean(doAmbiente.appSecret && doAmbiente.verifyToken)}
      // Leitura que falhou não pode virar "nunca configurado": essa frase
      // levaria o dono a gerar um token por cima do que já está colado na Meta.
      leituraFalhou={Boolean(error)}
    />
  );
}

function formatar(iso: string | null, idioma: Idioma): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleString(tagDeIdioma(idioma), {
    // Fuso fixo pelo mesmo motivo de `/admin/google`: a linha é da INSTALAÇÃO,
    // não há organização de onde tirar um, e formatar no cliente faria o HTML
    // servido e a hidratação divergirem.
    timeZone: "America/Sao_Paulo",
    dateStyle: "short",
    timeStyle: "short",
  });
}
