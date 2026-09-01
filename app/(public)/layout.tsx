import { createClient } from "@/lib/supabase/server";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";

/**
 * A casca das telas de acesso — login, cadastro, recuperação, MFA.
 *
 * ── Por que este layout não desenha mais nada ─────────────────────────────────
 *
 * Ele já foi a moldura visual das seis telas: uma coluna estreita e centrada, com
 * o logo por cima. Depois do redesenho o `/login` virou um painel dividido em
 * duas colunas de tela cheia, e uma coluna `max-w-sm` centrada em volta dele
 * seria uma caixa espremendo o desenho por fora.
 *
 * A moldura antiga não sumiu — virou `components/auth/FachadaCentrada.tsx`, que
 * as outras CINCO telas usam. E o logo, que era a razão de este layout existir
 * (uma resolução da marca, não seis), virou `components/auth/LogoDaFachada.tsx`,
 * usado tanto pela casca centrada quanto pelo painel do `/login`. Continua sendo
 * um lugar só; só não é mais ESTE lugar.
 *
 * O que sobrou aqui é o que de fato é comum às seis: o idioma.
 */
export default async function PublicLayout({ children }: { children: React.ReactNode }) {
  // A maioria destas telas roda ANTES do login (não há usuário nenhum), mas
  // duas — `/login/mfa` e, em parte, `/login/recovery` — rodam com uma sessão
  // parcial já criada (primeiro fator verificado, segundo pendente). Onde há
  // sessão, o idioma salvo no perfil vale; sem ela, `IdiomaProvider` já cai no
  // padrão pt-BR sozinho (ver o cabeçalho do provider) — nunca lança.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const locale = (user?.user_metadata?.locale as string | undefined) ?? null;

  return <IdiomaProvider locale={locale}>{children}</IdiomaProvider>;
}
