import { notFound } from "next/navigation";

import { loadAuthUser } from "@/lib/auth/server";
import { haAvisoDeTrocaDeModo } from "@/lib/auth/aviso-da-troca-de-modo";
import { modoDeCadastro } from "@/lib/auth/politica-de-cadastro";
import { listPendingRegistrationRequests } from "@/lib/auth/registration-requests";
import { traduzir } from "@/lib/i18n/dicionario";

import { FormularioDeCadastro } from "./_form";
import { PedidosPendentes } from "./_pedidos";

export const metadata = { title: "Cadastro na instalação" };
export const dynamic = "force-dynamic";

/**
 * A tela onde o dono da instalação decide se aceita cadastro aberto.
 *
 * ── O defeito que ela fecha ─────────────────────────────────────────────────
 *
 * `/signup` sempre foi aberto e não havia como fechá-lo pelo produto. Quem
 * hospeda a própria instalação e vende tenant precisava bloquear a rota no
 * proxy reverso — fora do produto, e sem saber o que é um convite. Medido numa
 * instalação real em 2026-09-10: a regra de nginx que fazia isso barrava junto
 * o `/signup?invite=…`, exatamente quem deveria passar.
 *
 * ── Por que `/admin`, e não `/app/settings` ─────────────────────────────────
 *
 * O objeto é a INSTALAÇÃO. Num revendedor que hospeda várias empresas, deixar o
 * admin de um tenant fechar o cadastro impediria QUALQUER outra empresa de
 * entrar. Mesmo argumento de `/admin/marca` e `/admin/google`, e esta tela é
 * irmã das duas.
 *
 * ── Por que `notFound()`, e não `redirect('/403')` ──────────────────────────
 *
 * Para quem não administra a instalação, esta tela não faz parte do produto. O
 * layout de `(protected)` já roda `requirePlatformAdmin()`, então o gate abaixo
 * é redundante HOJE; ele fica porque a garantia precisa ser local, e um layout
 * pode ser movido. Mesma decisão, mesma frase, de `/admin/google`.
 */
export default async function Page() {
  const usuario = await loadAuthUser();
  if (!usuario?.is_platform_admin) notFound();

  // A fila só é lida com a chave ligada: desligada, esta tela é a de antes.
  const modo = await modoDeCadastro();
  const pedidos = modo === "com_aprovacao" ? await listPendingRegistrationRequests() : null;

  // #1668 — o kit só leva o modo novo ao GoTrue no `install`/`update.sh`, então
  // a troca feita aqui vale para a regra do CRM na hora e para o cadastro DIRETO
  // só na próxima atualização. Se dá para perguntar ao GoTrue e ele está com
  // outro valor, a tela conta; não deu para perguntar, não há o que contar.
  const aviso = await haAvisoDeTrocaDeModo(modo);
  // O `update.sh` só grava o `DISABLE_SIGNUP` sob `SINGLE_SERVER=1` (a mesma
  // variável, no mesmo `.env` que o compose passa ao app). Com Supabase
  // separado, mandar rodar o update.sh seria instrução errada e aviso eterno:
  // ali quem muda é o operador, no painel ou no env do GoTrue próprio.
  const kitSincroniza = process.env.SINGLE_SERVER === "1";
  const alvoDoGoTrue = modo === "so_convite" ? "true" : "false";

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          {traduzir("Cadastro", usuario.idioma)}
        </h1>
        <p className="text-sm text-muted-foreground">
          {traduzir("Quem pode criar uma conta nesta instalação.", usuario.idioma)}
        </p>
      </div>
      {aviso && (
        <div
          role="status"
          className="rounded-md border border-amber-300/60 bg-amber-50 px-4 py-3 text-sm dark:border-amber-500/30 dark:bg-amber-950/20"
        >
          <p className="font-medium">
            {traduzir("A troca de modo ainda não chegou ao servidor.", usuario.idioma)}
          </p>
          {kitSincroniza ? (
            <>
              <p className="mt-1">
                {traduzir(
                  "A troca só vale para o cadastro direto depois da próxima atualização do servidor: o CRM já segue o modo novo, mas o GoTrue da VPS continua com o modo anterior. Esta tela só avisa — nada é corrigido aqui.",
                  usuario.idioma,
                )}
              </p>
              <p className="mt-2">
                {traduzir("Para aplicar agora, rode isto na VPS:", usuario.idioma)}
              </p>
              <code className="mt-1 block overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs">
                bash hostgator-setup-kit/update.sh
              </code>
            </>
          ) : (
            <>
              <p className="mt-1">
                {traduzir(
                  "Com o Supabase separado, o cadastro direto não acompanha a troca sozinho: o CRM já segue o modo novo, mas o Supabase continua com o modo anterior. Esta tela só avisa — nada é corrigido aqui.",
                  usuario.idioma,
                )}
              </p>
              <p className="mt-2">
                {modo === "so_convite"
                  ? traduzir(
                      'No painel do Supabase, em Authentication → Sign In / Up, desligue "Allow new users to sign up".',
                      usuario.idioma,
                    )
                  : traduzir(
                      'No painel do Supabase, em Authentication → Sign In / Up, ligue "Allow new users to sign up".',
                      usuario.idioma,
                    )}
              </p>
              <p className="mt-2">
                {traduzir("Em GoTrue próprio, a chave equivalente é:", usuario.idioma)}
              </p>
              <code className="mt-1 block overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs">
                DISABLE_SIGNUP={alvoDoGoTrue}
              </code>
            </>
          )}
        </div>
      )}
      <FormularioDeCadastro modoInicial={modo} />
      {pedidos && <PedidosPendentes pedidos={pedidos} />}
    </div>
  );
}
