/**
 * Semente do módulo "Distribuição de atendimento": a tela parte do padrão de
 * fábrica. As escolhas da organização (modo, visibilidade, assinatura, telefone)
 * moram em organizations.settings, que a base já devolve ao estado de fábrica.
 * O que sobra é a regra POR NÚMERO, que a lição "Responsáveis por número" grava
 * de verdade: ela mora em channel_routing_policies, fora do alcance da base.
 *
 * A tabela só aceita escrita pela RPC fn_set_channel_routing (nem a service role
 * tem DELETE), e a RPC exige uma sessão de manager+. Então a semente entra como
 * a Helena e pede "Voltar ao padrão da organização" — o mesmo caminho do botão
 * da tela. Só entra quando há regra a desfazer.
 */
import { createClient } from "@supabase/supabase-js";

import { type Contexto, exigir, semErro } from "../semear-demonstracao";

export async function semear(c: Contexto) {
  const regras = exigir(
    await c.db.from("channel_routing_policies").select("channel_session_id").eq("organization_id", c.org),
    "regras por número",
  ) as Array<{ channel_session_id: string }>;
  if (regras.length === 0) return;

  const helena = await c.db.auth.admin.getUserById(c.pessoa.helena);
  const email = helena.data.user?.email;
  if (!email) throw new Error("e-mail da Helena não encontrado");
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
  if (!anon) throw new Error("defina NEXT_PUBLIC_SUPABASE_ANON_KEY (o .env.e2e tem)");
  const sessao = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", anon, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const login = await sessao.auth.signInWithPassword({ email, password: process.env.CURSO_SENHA ?? "Curso!Demo2026" });
  if (login.error) throw new Error(`entrar como Helena: ${login.error.message}`);
  for (const r of regras) {
    semErro(
      await sessao.rpc("fn_set_channel_routing", { p_org: c.org, p_channel: r.channel_session_id, p_users: [], p_reset: true }),
      "voltar o número ao padrão da organização",
    );
  }
}
