/**
 * Criar a conta de quem foi CONVIDADO quando o GoTrue está com o cadastro
 * público fechado (`disable_signup`) — issue #1653.
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * Com `signup_mode = 'so_convite'` o CRM recusava cadastro sem convite na tela,
 * na server action `signUp` e na volta do Google — mas o GoTrue seguia aceitando
 * `POST /auth/v1/signup` direto, com a anon key que vai para o navegador. Não
 * bastava ligar o `disable_signup` do GoTrue para fechar esse caminho: o CONVITE
 * depende do mesmo endpoint (`app/team/accept-invite/[token]` manda para
 * `/signup?invite=…`, que cria a conta com `supabase.auth.signUp()`), e fechar
 * o GoTrue quebrava exatamente quem deveria entrar.
 *
 * ─── O conserto, em duas pezas ──────────────────────────────────────────────
 *
 * 1. a instalação em `so_convite` sincroniza `DISABLE_SIGNUP` no .env do
 *    Supabase dela (função `sincronizar_signup_mode_do_gotrue` do kit) — é o
 *    que fecha o caminho direto para TODO MUNDO, inclusive para quem tem a anon
 *    key;
 * 2. este módulo cria a conta do CONVIDADO pela admin API
 *    (`auth.admin.createUser`), que não depende do cadastro público, e volta o
 *    e-mail de confirmação pelo mesmo canal de sempre — o fluxo depois disso
 *    (`/auth/confirm` → `decidirConviteDoSignup` → `aplicarConvite`) não muda
 *    uma linha.
 *
 * ─── Por que o caminho antigo continua sendo o padrão ───────────────────────
 *
 * Aqui só se entra quando o GoTrue DIZ que o cadastro público está fechado (o
 * `disable_signup` vem de `GET /auth/v1/settings`, que é público). Instalação
 * em `aberto` — e até `so_convite` que ainda não sincronizou — segue no
 * `supabase.auth.signUp()` de sempre: o comportamento de quem já funciona não
 * muda por causa de quem precisa deste conserto. Não deu para perguntar ao
 * GoTrue (rede, placeholder de teste) também cai no caminho de sempre.
 *
 * ─── Sobre usar o client admin num fluxo de usuário final ───────────────────
 *
 * O cabeçalho de `lib/supabase/admin.ts` proíbe o admin client "em fluxo normal"
 * por um motivo de ESCOPO: service_role bypassa RLS, então quem o usa tem de
 * resolver `organization_id` por conta própria. Aqui ele não lê nem escreve
 * dado de tenant nenhum — cria UMA conta de auth com o e-mail que o convite
 * ASSINADO já autorizou, e devolve. É o mesmo uso que `lib/auth/provision.ts`
 * faz (`auth.admin.createUser`), e o que a própria issue sugere.
 */
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/** O que o GoTrue conta de si no endpoint público de settings. */
export type ConfigPublicaDoGoTrue = {
  /** `true` = `POST /auth/v1/signup` recusa cadastro novo (inclusive por OAuth). */
  disable_signup: boolean;
};

/**
 * `GET /auth/v1/settings` — anon key, mesmo caminho que o navegador usa.
 *
 * NUNCA LANÇA e devolve `null` quando não deu para perguntar: "não sei" não
 * pode virar "cadastro aberto" (aí sairíamos pelo caminho errado) nem
 * "cadastro fechado" (aí quebraríamos o convite numa instalação que está
 * aberta). Quem chama trata `null` como "segue o de sempre".
 */
export async function lerConfigPublicaDoGoTrue(): Promise<ConfigPublicaDoGoTrue | null> {
  try {
    // Sem a barra final: `https://x/` + `/auth/v1/settings` vira `//auth`, o
    // gateway responde 404, e o `null` mandaria o convite para o caminho que o
    // GoTrue fechado recusa.
    const base = env.NEXT_PUBLIC_SUPABASE_URL.replace(/\/+$/, "");
    const resposta = await fetch(`${base}/auth/v1/settings`, {
      headers: { apikey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY },
      cache: "no-store",
    });
    if (!resposta.ok) return null;
    const corpo = (await resposta.json()) as { disable_signup?: unknown };
    return typeof corpo.disable_signup === "boolean" ? { disable_signup: corpo.disable_signup } : null;
  } catch {
    return null;
  }
}

export type ResultadoDaContaDeConvite =
  | { ok: true; sessao_ativa: false }
  | {
      ok: false;
      /**
       * `conta_ja_existe`: já havia conta para este e-mail (só acontece com
       * convite na mão, então não fura a anti-enumeração — o comentário disso
       * está em `signUp.ts`). Os outros três são falha de infraestrutura.
       */
      motivo: "conta_ja_existe" | "rate_limited" | "criacao_recusada" | "email_de_confirmacao_falhou";
      detalhe?: string;
    };

/**
 * Cria a conta do convidado pela admin API e manda o e-mail de confirmação.
 *
 * Por que admin API: `auth.signUp()` é o endpoint que o `disable_signup`
 * bloqueia; `auth.admin.createUser` não é. Por que o `email_confirm: false` +
 * `resend` e não `email_confirm: true`: pular a confirmação daria a qualquer um
 * que colasse o link do convite (link reencaminhável) a conta de OUTRO e-mail —
 * a prova de caixa postal é o e-mail de confirmação indo para o ENDEREÇO DO
 * CONVITE, e ela continua no lugar.
 *
 * O `auth.admin.createUser` do GoTrue NÃO dispara e-mail nenhum (medido no
 * fonte supabase/auth v2.196.0: `adminUserCreate` só grava o usuário), então o
 * reenvio é explícito — pelo `POST /auth/v1/resend`, que é público, não tem
 * trava de cadastro e usa a mesma chave de sempre.
 *
 * Se o reenvio falhar, a conta recém-criada é APAGADA e o erro é devolvido:
 * sem isso a pessoa ficaria com conta sem e-mail e toda nova tentativa cairia
 * em "conta já existe" — a conta órfã que a issue inteira existe para não
 * acumular.
 */
export async function criarContaDeConvite(params: {
  email: string;
  password: string;
  inviteToken: string;
  fullName: string;
  emailRedirectTo: string;
}): Promise<ResultadoDaContaDeConvite> {
  const admin = createAdminClient();
  const { data, error } = await admin.auth.admin.createUser({
    email: params.email,
    password: params.password,
    email_confirm: false,
    user_metadata: { invite_token: params.inviteToken, full_name: params.fullName },
  });

  if (error || !data?.user) {
    const detalhe = error?.message ?? "sem usuário devolvido";
    if (error?.status === 429) return { ok: false, motivo: "rate_limited" };
    // `email_exists` é o código do GoTrue atual; versões anteriores só diziam
    // 422 com "already been registered" na mensagem (mesma régua de
    // `lib/auth/provision.ts`).
    const jaExiste =
      error?.code === "email_exists" || /already (been )?registered|already exists/i.test(detalhe);
    if (jaExiste) return { ok: false, motivo: "conta_ja_existe" };
    return { ok: false, motivo: "criacao_recusada", detalhe };
  }

  // Mesmo cliente anônimo de sempre: quem manda no `/resend` é a chave pública,
  // igualzinho ao `supabase.auth.signUp()` que este caminho substitui.
  const supabase = await createClient();
  const { error: erroResend } = await supabase.auth.resend({
    type: "signup",
    email: params.email,
    options: { emailRedirectTo: params.emailRedirectTo },
  });

  if (erroResend) {
    const { error: erroDelete } = await admin.auth.admin.deleteUser(data.user.id);
    if (erroDelete) {
      // A conta ficou para trás. Não dá para desfazer em silêncio: é o único
      // caso em que este caminho pode deixar uma conta órfã, e quem investiga
      // precisa achar a linha na trilha.
      logger.error("convite: não deu para desfazer a conta após falha no e-mail de confirmação", {
        user_id: data.user.id,
        detalhe: erroDelete.message,
      });
    }
    return {
      ok: false,
      motivo: "email_de_confirmacao_falhou",
      detalhe: erroResend.message,
    };
  }

  // `sessao_ativa: false` sempre: sem sessão daqui, a tela continua mandando a
  // pessoa para o e-mail de confirmação — que foi, de fato, enviado. Quem tem
  // `mailer_autoconfirm` ligado ganha um clique a mais e o mesmo desfecho.
  return { ok: true, sessao_ativa: false };
}
