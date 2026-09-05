/**
 * GET /api/v1/system/version — estado da atualização para a tela.
 *
 * Responde 200 para qualquer sessão, mas só entrega o estado operacional a
 * quem é dono do servidor (`is_platform_admin`). Quem não pode agir vê apenas
 * a versão instalada: aviso sem ação disponível é só ansiedade.
 */
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { loadAuthUser } from "@/lib/auth/server";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { extractChangelogRange } from "@/lib/system/changelog";
import { isRunStale, rollbackFoiSuperado, type RunStatus, type RunStep } from "@/lib/system/update-run";

export const dynamic = "force-dynamic";

/** Sem notícia do agente por 24h, a tela ensina o caminho manual. */
const AGENT_OFFLINE_AFTER_MS = 24 * 60 * 60 * 1000;

export async function GET(_req: NextRequest): Promise<Response> {
  const user = await loadAuthUser();
  // `unauthenticated` (não `unauthorized`): esse último é reservado ao segredo
  // interno das rotas host↔app (lib/api/errors.ts) — aqui falta é sessão.
  if (!user) return fail("unauthenticated", "Faça login para continuar.", 401);

  const db = createAdminClient();
  const { data: version, error: versionError } = await db
    .from("system_version")
    .select(
      "current_version, latest_version, off_release, compare_failed, has_known_release, changelog_raw, agent_last_seen_at, updated_at",
    )
    .eq("id", 1)
    .maybeSingle();

  // Sem checar o erro, uma falha de leitura vira `current = ""` em silêncio —
  // e mais abaixo isso poderia se disfarçar de "sem atualização disponível".
  if (versionError) {
    logger.error("[system/version] leitura de system_version falhou", { error: versionError.message });
    return fail("internal_error", "Não consegui ler o estado da atualização.", 500);
  }

  const current = version?.current_version ?? "";

  // `from_version`/`to_version`/`log_tail` NÃO são enfeite: numa falha, a
  // versão do `system_version` é o `git describe` do HOST, e o checkout já
  // aconteceu — ela nomeia a versão que QUEBROU, não a que está no ar. Quem
  // sabe disso é o run (de onde saiu, para onde tentou ir). E o log é o único
  // diagnóstico que o dono tem sem abrir um terminal, que é justamente o que
  // esta feature existe para eliminar.
  //
  // Lido ANTES da bifurcação por papel de propósito: o rodapé da sidebar (que
  // todo mundo vê) e esta tela precisam falar da MESMA versão — a que está
  // rodando.
  const { data: run, error: runError } = await db
    .from("system_update_runs")
    .select("id, status, last_step, dispatched_at, finished_at, from_version, to_version, log_tail")
    .order("dispatched_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (runError) {
    logger.error("[system/version] leitura do run mais recente falhou", { error: runError.message });
    return fail("internal_error", "Não consegui ler o estado da atualização.", 500);
  }

  const now = new Date();
  const lastSeen = version?.agent_last_seen_at ? Date.parse(version.agent_last_seen_at) : NaN;

  // A versão que a tela mostra é a do APP QUE ESTÁ RODANDO. Depois de um
  // rollback, o host reporta a versão nova (o `git checkout` deu certo; quem
  // não subiu foi o container), então `current_version` nomearia justamente a
  // versão que quebrou. Quem sabe qual imagem voltou ao ar é o run.
  //
  // Mas o run só sabe disso ENQUANTO ninguém trocou o app por outro caminho — e
  // trocar por outro caminho é o normal: `docker compose up -d`, deploy por CI,
  // `update.sh` no terminal. Nenhum deles cria run. Sem fim de validade, um
  // rollback de agosto seguia nomeando a versão no ar em setembro (medido em
  // produção: o rodapé anunciava `3414a2df` oito dias e vários deploys depois).
  //
  // O desempate é temporal e vem do próprio banco: `system_version.updated_at`
  // é gravado pelo agente do host a cada batida, e se ele é POSTERIOR ao fim do
  // run, o agente viu o mundo mais recente. Sem o par de datas — run de um
  // agente antigo, sem `finished_at` — fica valendo o run, que continua sendo a
  // informação mais específica que a instalação tem.
  const rollbackSuperado = rollbackFoiSuperado(version?.updated_at, run?.finished_at);
  const running =
    run?.status === "failed_rolled_back" && run.from_version && !rollbackSuperado
      ? run.from_version
      : current;

  if (!user.is_platform_admin) {
    return ok({ current_version: running, is_owner: false });
  }

  const latest = version?.latest_version ?? "";
  // A faixa INTEIRA entre o que está no ar e o que vai entrar, não só a seção
  // da versão-alvo. Mostrar só a alvo perdia aviso: quem pulava da 1.4.0 para a
  // 1.6.0 nunca lia a 1.4.1 nem a 1.5.0 — e a 1.4.1 existia para corrigir uma
  // instrução invertida que mandava apagar a conexão que estava funcionando.
  //
  // O limite inferior é `running`, NUNCA `current`: depois de um rollback,
  // `current` nomeia a versão que quebrou, e a faixa sairia vazia justamente
  // para quem mais precisa lê-la.
  const faixa = latest ? extractChangelogRange(version?.changelog_raw ?? "", latest, running) : null;

  return ok({
    current_version: running,
    is_owner: true,
    latest_version: latest,
    update_available: Boolean(latest) && latest !== running,
    off_release: version?.off_release ?? false,
    // Sem isto, a tela lê "sem versão nova anunciada" como "você está em dia" —
    // e uma instalação atrasada cujo host não conseguiu comparar é informada de
    // que está atualizada, em silêncio.
    compare_failed: version?.compare_failed ?? false,
    // Só importa quando `off_release` e sem `latest_version` — distingue "à
    // frente da última publicada" (existe release, já contida no HEAD) de
    // "este fork nunca teve release nenhuma". Default `true`: preserva "à
    // frente da publicada" para quem nunca gravou este campo (linha ainda
    // não tocada por nenhum heartbeat, coluna com o default da migration).
    has_known_release: version?.has_known_release ?? true,
    agent_online: !Number.isNaN(lastSeen) && now.getTime() - lastSeen < AGENT_OFFLINE_AFTER_MS,
    notes:
      faixa && faixa.secoes.length > 0
        ? {
            // Consolidados no topo, cada um dizendo de que versão veio: numa
            // faixa de várias versões, "reconecte o número" sem dizer de qual
            // release não informa o operador — assusta.
            requires_attention: faixa.secoes
              .filter((s) => s.requiresAttention)
              .map((s) => ({ version: s.version, texto: s.requiresAttention ?? "" })),
            sections: faixa.secoes.map((s) => ({ version: s.version, body: s.body })),
            // `false` = o texto recebido não alcança a versão que está no ar, e
            // a última seção da lista pode estar cortada no meio da frase. A
            // tela precisa DIZER isso — corpo truncado é indistinguível de
            // corpo inteiro para quem lê.
            complete: faixa.completa,
          }
        : null,
    run: run
      ? {
          id: run.id,
          // `unknown` é derivado aqui, não gravado: um agente morto não
          // consegue anunciar a própria morte.
          status:
            run.status === "dispatched" && isRunStale(run.dispatched_at, now)
              ? ("unknown" as const)
              : (run.status as RunStatus),
          last_step: (run.last_step as RunStep | null) ?? null,
          from_version: run.from_version ?? "",
          to_version: run.to_version ?? "",
          log_tail: run.log_tail ?? "",
        }
      : null,
  });
}
