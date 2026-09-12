/**
 * channel-health — o vigia que PERGUNTA se a conexão está de pé.
 *
 * ─── Por que perguntar, se o webhook já conta ──────────────────────────────
 *
 * Porque o webhook emudece exatamente quando mais falta. Ele avisa em segundos
 * enquanto o transporte está vivo; quando o transporte morre, o container cai ou
 * a assinatura do webhook se perde, não chega evento nenhum — e "nenhum evento"
 * é indistinguível de "tudo bem". A coluna segue dizendo `WORKING` para sempre.
 *
 * Foi assim que uma desconexão real passou horas despercebida numa instalação de
 * verdade: nada quebrou, nada alertou, e o dono só descobriu ao estranhar que
 * ninguém escrevia e ir olhar por conta própria.
 *
 * Este cron fecha esse buraco pelo único jeito que existe: fazendo a pergunta.
 * Silêncio deixa de ser resposta.
 *
 * ─── O que ele NÃO faz ─────────────────────────────────────────────────────
 *
 * Não reinicia sessão. Religar sozinho uma conexão que caiu por bloqueio da
 * plataforma é a receita para transformar uma suspensão temporária em definitiva
 * — e reconectar exige, com frequência, um humano com o celular na mão. O vigia
 * informa; a decisão é de quem lê.
 *
 * ─── E o watchdog do worker, que RELIGA? ───────────────────────────────────
 *
 * `lib/agent-engine/edge/crm/session-reconciler.ts` religa — e as duas regras
 * não se contradizem porque falam de estados diferentes. Ele retoma APENAS
 * `STOPPED`, que é a sessão que o transporte não iniciou (contêiner reiniciado,
 * com a credencial intacta no volume), e NUNCA `FAILED` nem `SCAN_QR_CODE`, que
 * são justamente os estados de sessão derrubada pela plataforma ou deslogada. É
 * sobre esses dois que o parágrafo acima fala, e sobre eles nada religa sozinho.
 *
 * Se alguém for afrouxar aquele filtro, é este parágrafo que precisa cair
 * primeiro — e a razão dele continua de pé.
 *
 * Auth: Bearer INTERNAL_CRON_SECRET|INTERNAL_SECRET (fail-closed), como os demais.
 *
 * NOTA DE DEPLOY: o agendamento vive no serviço `scheduler` do
 * `docker-compose.prod.yml` — não há `vercel.json` neste repo (self-host).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import {
  CHANNEL_SESSION_REF_COLUMNS,
  DEFAULT_CHANNEL_PROVIDER,
  getAdapter,
  resolveSessionRef,
  canalConhecidoSemMensagem,
  type ChannelProvider,
  type ChannelSessionRef,
} from "@/lib/channels";
import { sincronizarSaudeDaConexao } from "@/lib/channels/health";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** Teto por rodada. Cada sessão é uma chamada de rede ao transporte. */
const LIMITE = 50;

type LinhaDeSessao = ChannelSessionRef & {
  id: string;
  organization_id: string;
  status: string | null;
  display_name: string | null;
  phone_number: string | null;
  archived_at: string | null;
};

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const auth = req.headers.get("authorization") ?? "";
  const provided = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const accepted = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(Boolean);
  if (accepted.length === 0 || !provided || !accepted.includes(provided)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const admin = createAdminClient();

  // Arquivada não é vigiada: ela foi desligada de propósito, e avisar que uma
  // conexão aposentada está parada é exatamente o ruído que faz o operador
  // ignorar a Central.
  const { data, error } = await admin
    .from("channel_sessions")
    .select(
      `id, organization_id, status, display_name, phone_number, archived_at, ${CHANNEL_SESSION_REF_COLUMNS}`,
    )
    .is("archived_at", null)
    .limit(LIMITE);

  if (error) {
    logger.error("[channel-health] query falhou", { detail: error.message, requestId });
    return fail("internal_error", error.message, 500, { requestId });
  }

  const sessoes = (data ?? []) as LinhaDeSessao[];
  let verificadas = 0;
  const desfechos: Record<string, number> = {};
  let ignoradas = 0;

  for (const s of sessoes) {
    // Canal CONHECIDO que não transporta mensagem não tem saúde de mensagem a
    // vigiar — e a linha de chamada de voz (spec 18) é uma dessas. Este
    // `continue` vem ANTES de `getAdapter` de propósito: é decisão de escopo,
    // não erro, e um `warn` por sessão de voz a cada minuto seria ruído
    // perpétuo. É `canalConhecidoSemMensagem` e não `!transportaMensagem`
    // justamente para que um provider DESCONHECIDO não caia aqui em silêncio:
    // ele segue para o `getAdapter` abaixo, que lança, e o `catch` da iteração
    // deixa o rastro.
    if (canalConhecidoSemMensagem(s.provider)) {
      ignoradas++;
      continue;
    }

    try {
      // Pergunta ao CANAL, não ao provider: quem tem sessão para consultar
      // implementa `checkHealth`; quem não tem simplesmente não o expõe, e o
      // vigia segue adiante sem nunca perguntar QUEM ele é — o invariante 1 da
      // doutrina.
      //
      // DENTRO do try, e a diferença é a rodada inteira: `getAdapter` falha
      // FECHADO (`unknown_channel_provider`), e o `catch` desta iteração fica
      // logo abaixo. Enquanto a chamada morava fora, um provider que o banco já
      // aceita e esta imagem ainda não conhece — o clone que aplicou o baseline
      // antes de puxar a imagem nova — abortava `handle()` no meio do laço:
      // TODOS os tenants seguintes daquela rodada ficavam sem vigia, e o
      // operador via 500 no cron sem nenhuma pista de qual linha o derrubou.
      const adapter = getAdapter((s.provider ?? DEFAULT_CHANNEL_PROVIDER) as ChannelProvider);
      const sessionRef = resolveSessionRef(s);
      if (!adapter.checkHealth || !sessionRef) continue;

      const saude = await adapter.checkHealth({
        organizationId: s.organization_id,
        sessionRef,
      });
      verificadas++;

      // O status novo vale para o banco, mas SÓ quando deu para perguntar:
      // gravar por cima com um erro de rede transitório trocaria informação boa
      // por ruído, e é o mesmo cuidado que a tela de conexões já toma.
      let statusFinal = s.status;
      if (saude.reachable && saude.status && saude.status !== s.status) {
        statusFinal = saude.status;
        const agora = new Date().toISOString();
        await admin
          .from("channel_sessions")
          .update({ status: saude.status, last_status_change_at: agora })
          .eq("id", s.id)
          .eq("organization_id", s.organization_id);
      }

      const apelido = s.display_name ?? s.phone_number ?? "sem nome";
      const desfecho = await sincronizarSaudeDaConexao(
        admin,
        { id: s.id, organization_id: s.organization_id, status: statusFinal },
        saude,
        apelido,
      );
      desfechos[desfecho] = (desfechos[desfecho] ?? 0) + 1;
    } catch (err) {
      // Uma sessão problemática não derruba o lote — as outras ainda precisam
      // ser vigiadas, e é justamente numa rodada assim que alguma pode ter caído.
      logger.warn("[channel-health] falhou numa sessão", {
        sessionId: s.id,
        detail: err instanceof Error ? err.message : "erro",
        requestId,
      });
    }
  }

  return ok({ sessoes: sessoes.length, verificadas, ignoradas, ...desfechos }, { requestId });
}

export const GET = handle;
export const POST = handle;
