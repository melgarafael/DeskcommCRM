/**
 * POST /api/v1/ai/cases/alerta/teste — "enviar aviso de teste".
 *
 * ## Ele manda de VERDADE, e é por isso que ele existe
 *
 * O que quebra o aviso de caso não é o envio: é a fila de condições antes dele
 * (canal arquivado, canal que só manda modelo aprovado, canal parado, endereço
 * público ausente, transporte fora do ar, teto do aquecimento, destino que o
 * canal não sabe endereçar). Um botão que simulasse ficaria verde exatamente
 * nas instalações em que o aviso nunca vai sair. A regra do caminho está em
 * `lib/escalacao/aviso-de-teste.ts`, e ela é a do motor a partir do canal.
 *
 * ## Balde de rate limit PRÓPRIO, e ele não é zelo
 *
 * Um número recém-pareado tem cap de **20 mensagens por dia** no aquecimento.
 * Sem um teto próprio, cinco conferências seguidas consomem um quarto do dia do
 * número — e o aviso real que chegasse depois seria represado por uma conta que
 * a pessoa não sabia estar fazendo. Três por hora, por organização (não por
 * usuário: o número é da organização, e dois admins conferindo gastam o mesmo
 * teto).
 *
 * ## Recusa devolve 200, e isso é decisão
 *
 * "O teste rodou e o aviso não saiu, porque o número está no limite de hoje" é
 * a RESPOSTA que o botão pediu — não uma falha da requisição. Num 4xx o motivo
 * cairia no envelope de erro e o tratamento genérico da tela o trocaria por
 * "erro inesperado", apagando a única informação que o clique existia para
 * produzir. Falha de requisição de verdade (sem configuração salva, sem papel)
 * continua sendo 4xx.
 *
 * ## i18n
 *
 * `PASTAS_IGNORADAS` do gate de espanhol inclui `api`: as frases daqui entram
 * no dicionário por DISCIPLINA, não por catraca.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { criarPacingDoCanal } from "@/lib/agent-engine/pacing/ledger-supabase";
import { env } from "@/lib/env";
import { createSupabaseAvisoDb, mascara } from "@/lib/escalacao/aviso-ao-suporte";
import { criarTransporteDoAviso } from "@/lib/escalacao/aviso-ao-suporte.handler";
import { enviarAvisoDeTeste } from "@/lib/escalacao/aviso-de-teste";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** Três por hora, por organização. Ver o cabeçalho: o teto do número é 20/dia. */
const TESTES_POR_HORA = 3;
const JANELA_SEGUNDOS = 3600;

export async function POST(_req: NextRequest): Promise<Response> {
  // PRIMEIRO passo do handler: o teste GASTA uma mensagem do número do cliente,
  // e acompanhamento somente-leitura não gasta nada de ninguém.
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "config_aviso_de_caso" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  const balde = await checkRateLimit(`aviso-teste:${orgId}`, TESTES_POR_HORA, JANELA_SEGUNDOS);
  if (!balde.allowed) {
    return fail(
      "rate_limited",
      t("Você já mandou três testes nesta hora. Espere um pouco antes do próximo."),
      429,
      {
        requestId,
        headers: {
          "Retry-After": String(JANELA_SEGUNDOS),
          "X-RateLimit-Limit": String(balde.limit),
          "X-RateLimit-Remaining": String(Math.max(0, balde.limit - balde.count)),
        },
      },
    );
  }

  // A configuração SALVA, lida pelo client de sessão (a RLS desta tabela é
  // `admin`). O teste prova o que está EM VIGOR — testar os campos ainda não
  // salvos provaria um caminho que não é o que vai rodar.
  const db = await createClient();
  const { data, error } = await db
    .from("config_aviso_de_caso")
    .select("channel_session_id, telefone_destino, sem_link")
    .eq("organization_id", orgId)
    .maybeSingle();
  if (error) {
    return fail("internal_error", t("Não foi possível ler a configuração do aviso."), 500, {
      requestId,
    });
  }
  const cfg = data as {
    channel_session_id: string | null;
    telefone_destino: string;
    sem_link?: boolean;
  } | null;
  if (!cfg?.channel_session_id) {
    return fail(
      "aviso_nao_configurado",
      t("Escolha a conexão e o número e salve antes de mandar o teste."),
      422,
      { requestId },
    );
  }

  const admin = createAdminClient();
  const resultado = await enviarAvisoDeTeste(
    {
      // ⚠️ `createSupabaseAvisoDb` filtra `organization_id` À MÃO em toda
      // consulta — o client é o de service role, e a organização vem da sessão.
      db: createSupabaseAvisoDb(admin),
      transporte: await criarTransporteDoAviso(admin),
      pacing: await criarPacingDoCanal(admin),
      clock: () => new Date(),
      urlPublica: env.NEXT_PUBLIC_APP_URL,
    },
    {
      organizationId: orgId,
      channelSessionId: cfg.channel_session_id,
      telefone: cfg.telefone_destino,
      sem_link: cfg.sem_link ?? false,
    },
  );

  // Auditado nos DOIS desfechos: a tentativa é o fato, e a razão da recusa é o
  // que responde depois "por que o aviso não sai daqui". Sem o texto e com o
  // número MASCARADO — `api_audit_log` é append-only e a cascata de LGPD não o
  // alcança.
  void audit({
    action: "ai.case_alert_test_sent",
    organizationId: orgId,
    actorUserId: authz.user.id,
    resourceType: "config_aviso_de_caso",
    resourceId: orgId,
    metadata: {
      destino_mascarado: mascara(cfg.telefone_destino),
      canal: cfg.channel_session_id,
      enviado: resultado.enviado,
      ...(resultado.enviado ? {} : { motivo: resultado.codigo }),
    },
  });

  return ok(resultado, { requestId });
}
