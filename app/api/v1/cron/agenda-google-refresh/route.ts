/**
 * GET/POST /api/v1/cron/agenda-google-refresh — o anti-morte da agenda conectada.
 *
 * ─── Por que esta rota é trabalho novo, e não cópia de nada ───────────────
 *
 * Medido antes de escrever: **não existe nenhum worker, cron ou rota de refresh
 * de token OAuth neste repo**. `tenant_integrations` tem
 * `oauth_refresh_token_encrypted` e `expires_at` desde sempre, com ZERO leitores
 * e ZERO escritores — porque o token da Nuvemshop não expira. O do Google expira
 * em cerca de uma hora, e sem esta rodada a agenda conectada morre no fim do
 * primeiro dia útil, calada.
 *
 * É o invariante 7 do Sistema Vivo em forma de rota: o laço que fecha quando a
 * conexão erra.
 *
 * ─── O que ela NÃO faz, e cada ausência tem razão ─────────────────────────
 *
 * - **Não renova o que não está para vencer.** A varredura usa a folga de
 *   `precisaRenovar`, e o índice parcial que a 0177 criou para isto
 *   (`calendar_connections_renovacao_idx`) já exclui conexão desconectada.
 * - **Não desiste da rodada quando uma conexão falha.** Cada uma é tratada
 *   sozinha; um timeout numa agenda não pode deixar as outras sem renovar. É
 *   por isso que `renovarToken` e `classificarErroDoGoogle` não lançam.
 * - **Não audita rodada vazia.** Cron que não fez nada não é mutação — esta base
 *   já pagou 51.840 linhas/mês de batida vazia, e há um gate que varre o AST de
 *   toda rota de `app/api/v1/cron/` para impedir a reincidência.
 * - **Não apaga o `refresh_token`.** A resposta da renovação vem sem ele; quem
 *   gravar o que chegou apaga a chave que acabou de renovar. Por isso o token
 *   passa por `fundirTokens` antes de qualquer escrita.
 */

import { NextResponse, type NextRequest } from "next/server";
import { apenasDeMembrosAtivos } from "@/lib/agenda/google/membros";

import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptWebhookSecret, encryptWebhookSecret } from "@/lib/webhooks/secrets";
import { configuracaoDoGoogle } from "@/lib/agenda/google/config";
import { classificarErroDoGoogle, estadoDaConexaoApos } from "@/lib/agenda/google/erros";
import { fundirTokens, precisaRenovar, type TokenDoGoogle } from "@/lib/agenda/google/oauth";
import { renovarToken } from "@/lib/agenda/google/token";
import { autorizaCron } from "@/lib/auth/cron-auth";

export const dynamic = "force-dynamic";

/** Quanto à frente do vencimento a rodada já renova. Uma rodada de folga. */
export const JANELA_DE_RENOVACAO_MS = 15 * 60 * 1000;

/** Teto por rodada: renovar mil agendas num tick estouraria a cota do Google. */
export const TETO_POR_RODADA = 50;

export interface ResumoDaRodada {
  examinadas: number;
  renovadas: number;
  reautenticar: number;
  falhas: number;
  semAppOAuth: boolean;
}

interface LinhaDeConexao {
  id: string;
  organization_id: string;
  user_id: string;
  account_email: string;
  status: string;
  token_expires_at: string | null;
  oauth_access_token_encrypted: string | null;
  oauth_refresh_token_encrypted: string | null;
  scopes: string[] | null;
}

export async function renovarAgendasDoGoogle(
  admin: ReturnType<typeof createAdminClient>,
  opcoes: { agora: Date },
): Promise<ResumoDaRodada> {
  const resumo: ResumoDaRodada = {
    examinadas: 0,
    renovadas: 0,
    reautenticar: 0,
    falhas: 0,
    semAppOAuth: false,
  };

  const app = await configuracaoDoGoogle();
  if (!app) {
    // Instalação sem app OAuth não tem conexão para renovar. Não é falha, e não
    // audita — é o estado de quem nunca conectou o Google.
    resumo.semAppOAuth = true;
    return resumo;
  }

  const limite = new Date(opcoes.agora.getTime() + JANELA_DE_RENOVACAO_MS).toISOString();
  const { data, error } = await admin
    .from("calendar_connections")
    .select(
      "id, organization_id, user_id, account_email, status, token_expires_at, oauth_access_token_encrypted, oauth_refresh_token_encrypted, scopes",
    )
    .in("status", ["healthy", "rate_limited"])
    .not("token_expires_at", "is", null)
    .lte("token_expires_at", limite)
    .order("token_expires_at", { ascending: true })
    .limit(TETO_POR_RODADA);

  if (error || !data) return resumo;
  // A agenda de quem SAIU da organização para de ser lida. O token do Google
  // continua válido — ele não sabe nada de RH —, então o corte é aqui.
  const linhas = await apenasDeMembrosAtivos(admin, data as unknown as LinhaDeConexao[]);

  for (const linha of linhas) {
    resumo.examinadas += 1;

    // A varredura já filtrou pelo banco, mas a régua de "está na hora" é uma só
    // — a mesma que o caminho de uso aplica. Duas réguas divergiriam em silêncio.
    if (!precisaRenovar(linha.token_expires_at, opcoes.agora, JANELA_DE_RENOVACAO_MS)) continue;

    if (!linha.oauth_refresh_token_encrypted) {
      // Conexão sem chave de renovação não se recupera sozinha. Desde a rota de
      // callback isso não nasce mais; linhas antigas podem existir.
      await marcarConexao(admin, linha, "token_expired", "sem chave de renovação guardada");
      resumo.reautenticar += 1;
      continue;
    }

    const refresh = await decryptWebhookSecret(admin, linha.oauth_refresh_token_encrypted);
    if (!refresh) {
      // Decifra que falha é a chave de cifra da instalação ausente ou trocada.
      // Não rebaixa a conexão: o problema é do servidor, não da autorização, e
      // marcar `token_expired` mandaria a pessoa reconectar uma agenda boa.
      resumo.falhas += 1;
      continue;
    }

    const leitura = await renovarToken(app, refresh, { agora: opcoes.agora });
    if (!leitura.ok) {
      const classificacao = classificarErroDoGoogle({ error: leitura.detalhe }, "token");
      const novoEstado = estadoDaConexaoApos(classificacao.desfecho);
      if (novoEstado && novoEstado !== "healthy") {
        await marcarConexao(admin, linha, novoEstado, classificacao.mensagem);
        if (novoEstado === "token_expired") resumo.reautenticar += 1;
        else resumo.falhas += 1;
      } else {
        resumo.falhas += 1;
      }
      continue;
    }

    // ⚠️ A FUSÃO É OBRIGATÓRIA. A resposta da renovação vem sem `refresh_token`;
    // gravar o que chegou apagaria a chave que acabou de renovar.
    const anterior: TokenDoGoogle = {
      access_token: "",
      refresh_token: refresh,
      scope: linha.scopes ?? [],
      token_type: "Bearer",
      expira_em: linha.token_expires_at ?? opcoes.agora.toISOString(),
    };
    const fundido = fundirTokens(anterior, leitura.token);

    const accessCifrado = await encryptWebhookSecret(admin, fundido.access_token);
    if (!accessCifrado) {
      resumo.falhas += 1;
      continue;
    }

    const { error: erroAoGravar } = await admin
      .from("calendar_connections")
      .update({
        oauth_access_token_encrypted: accessCifrado,
        token_expires_at: fundido.expira_em,
        status: "healthy",
        last_sync_error: null,
      })
      .eq("id", linha.id);

    if (erroAoGravar) resumo.falhas += 1;
    else resumo.renovadas += 1;
  }

  // Só audita rodada que fez alguma coisa. Rodada vazia não é mutação.
  if (resumo.renovadas > 0 || resumo.reautenticar > 0 || resumo.falhas > 0) {
    await audit({
      action: "agenda.google.renovacao_executada",
      metadata: {
        examinadas: resumo.examinadas,
        renovadas: resumo.renovadas,
        reautenticar: resumo.reautenticar,
        falhas: resumo.falhas,
      },
    });
  }

  return resumo;
}

async function marcarConexao(
  admin: ReturnType<typeof createAdminClient>,
  linha: LinhaDeConexao,
  situacao: string,
  motivo: string,
): Promise<void> {
  await admin
    .from("calendar_connections")
    .update({ status: situacao, last_sync_error: motivo })
    .eq("id", linha.id);
}

async function executar(req: NextRequest): Promise<Response> {
  if (!autorizaCron(req)) {
    return NextResponse.json({ error: { code: "unauthenticated", message: "cron secret inválido" } }, { status: 401 });
  }
  const resumo = await renovarAgendasDoGoogle(createAdminClient(), { agora: new Date() });
  return NextResponse.json({ data: resumo });
}

export async function GET(req: NextRequest): Promise<Response> {
  return executar(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return executar(req);
}
