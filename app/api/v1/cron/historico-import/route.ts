/**
 * historico-import — anda as importações do histórico do WhatsApp (#999).
 *
 * As rotas da tela só mudam o ESTADO (`app/api/v1/channel-sessions/[id]/historico`):
 * quem lê o acervo e grava é este cron, UMA rodada por importação `rodando` a
 * cada chamada, com o teto padrão da rodada (3 conversas OU 300 mensagens OU
 * 20 chamadas ao canal). O teto não vem de fora: com menos de 3 chamadas a
 * rodada não avança. Todas as rodadas da chamada dividem `PRAZO_DA_CHAMADA_MS`
 * (`lib/channels/historico/prazo.ts`): a rodada não começa chamada ao canal sem
 * tempo para ela, e o `-m` do curl no agendador fica acima do prazo com folga.
 *
 * ─── Uma execução por importação ────────────────────────────────────────────
 *
 * O agendador chama a cada minuto e corta o `curl` em 60 s, mas o servidor
 * segue com o pedido. Sem prazo por rodada, uma rodada com mídia passava do
 * minuto (prova de 21/10: `curl: (28)`, e as chamadas seguintes puladas pela
 * trava); com ele, ainda pode haver sobreposição se o banco demorar. A rodada NÃO serializa execuções
 * simultâneas da mesma importação (ver `rodada.ts`): isso é daqui. A trava é
 * `cursor.trava_ate`, gravada por update condicional no `updated_at` que esta
 * chamada leu: quem perde a corrida não roda. A rodada apaga a trava sozinha,
 * porque grava o cursor dela inteiro (só `indiceConversa`, `offsetMensagens`, `conferida`,
 * `desde`). Se o processo morrer no meio, a trava vence em `TRAVA_MS`. Sem
 * migration: a chave mora no jsonb que já existe.
 *
 * Empresa parada fica de fora (a rodada gasta chamada ao canal e escreve).
 * Auditoria: início, cancelamento e retomada são das rotas; o FIM (concluída ou
 * erro) é daqui, uma linha por importação que terminou nesta chamada. Rodada que
 * só andou o cursor não audita (cron de minuto, ver
 * tests/unit/cron-audita-so-quando-ha-efeito.test.ts).
 *
 * Antes das rodadas (Spec 32): abre a importação de cada queda do número
 * (`lib/channels/historico/quedas.ts`), promove ou cancela as que esperam
 * (conferindo o número ao vivo) e fecha os avisos de cliente que já foi
 * respondido. Cada passo tem o seu try/catch; as rodadas seguem mesmo se um falhar.
 *
 * Auth: Bearer INTERNAL_SECRET (fail-closed), igual aos demais crons.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { fecharAvisosDeClienteRespondido } from "@/lib/channels/historico/avisos-da-queda";
import { MARGEM_PARA_CHAMADA_MS, PRAZO_DA_CHAMADA_MS } from "@/lib/channels/historico/prazo";
import {
  abrirRecuperacoesDasQuedas,
  organizacoesOperantes,
  prepararRecuperacoesAguardando,
} from "@/lib/channels/historico/quedas";
import { rodarUmaRodada, TETO_PADRAO } from "@/lib/channels/historico/rodada";
import { recursoOcioso } from "@/lib/cron/piso-ocioso";
import { logger } from "@/lib/logger";
import { STATUS_OPERANTE, ehOperante, statusDaOrgEmbutida } from "@/lib/organizacao/operante";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** Importações por chamada; as mais antigas (por `updated_at`) primeiro. */
const LOTE = 10;
/** Validade da trava: bem acima de uma rodada lenta, para não rodar em dobro. */
const TRAVA_MS = 5 * 60_000;

/**
 * O QUE RODA DEPOIS DO PORTÃO DO PISO OCIOSO (#3773), na ordem do arquivo.
 *
 * O `if (await recursoOcioso(...))` desta rota é saída antecipada da ROTA
 * INTEIRA: o que vier depois dele não roda em instalação ociosa. Esta lista é a
 * declaração do que roda ali — `tests/unit/cron-passa-pelo-portao.test.ts` lê o
 * AST deste arquivo e reprova, com arquivo e linha, quando o que está de fato
 * abaixo do portão divergir dela. Passo novo abaixo do portão entra aqui, e só
 * depois de a pessoa ver que ele NÃO roda na instalação parada, que é o caso
 * comum. O #3650 mediu o custo de não haver essa cerca: três passos novos nesta
 * rota ficaram antes da rodada e o autor teve de alargar o sinal do portão à mão
 * — os mesmos três, abaixo do `return`, teriam ficado mudos.
 *
 * Em runtime a constante não serve para nada — o `void` existe só para o lint
 * não acusar variável sem uso.
 */
const PASSOS_DEPOIS_DO_PORTAO = [
  "const agora",
  "const recuperacoes",
  "const passo",
  "expr await passo(...)",
  "expr await passo(...)",
  "let operantes",
  "expr await passo(...)",
  "for (organizationId of operantes)",
  "const prazo",
  "const {data, error}",
  "if (error)",
  "const linhas",
  "let rodadas",
  "let puladas",
  "let falhas",
  "const status",
  "for (l of linhas)",
  "return",
] as const;
void PASSOS_DEPOIS_DO_PORTAO;

interface Linha {
  id: string;
  organization_id: string;
  channel_session_id: string;
  cursor: Record<string, unknown> | null;
  updated_at: string;
  organizations?: { status?: string | null } | Array<{ status?: string | null }> | null;
}

function travada(cursor: Record<string, unknown> | null, agora: number): boolean {
  const ate = cursor?.trava_ate;
  return typeof ate === "string" && Date.parse(ate) > agora;
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const admin = createAdminClient();
  // O PISO OCIOSO (#3731): a rodada de todo minuto lia `importacoes_de_historico`
  // só para receber lista vazia em quem nunca importou o histórico. Com o portão,
  // a instalação sem importação, sem queda recente do número e sem aviso aberto sai antes dessa leitura — ver
  // lib/cron/piso-ocioso.ts para o sinal e o custo dele.
  if (await recursoOcioso("historico")) return ok({ pulado: "recurso_ocioso" }, { requestId });
  // O sinal do portão cobre também o que os passos de baixo fazem (quedas do número
  // e avisos abertos): sair aqui sem olhar para eles deixaria a recuperação muda.
  const agora = new Date();

  // Antes das rodadas (Spec 32): abre a importação de cada queda do número, confere
  // ao vivo o número de cada espera e fecha os avisos de cliente que já foi
  // respondido. Cada passo tem o seu try/catch: um que falha não para os outros
  // nem as rodadas. Os três ficam antes do prazo da chamada, que é das rodadas.
  const recuperacoes = { criadas: 0, promovidas: 0, canceladas: 0, avisosFechados: 0 };
  const passo = async (nome: string, executa: () => Promise<void>) => {
    try {
      await executa();
    } catch (err) {
      logger.warn(`[historico-import] ${nome} falhou`, {
        detail: err instanceof Error ? err.message : "erro",
        requestId,
      });
    }
  };
  await passo("abrir recuperações das quedas", async () => {
    recuperacoes.criadas = (await abrirRecuperacoesDasQuedas(admin, agora)).criadas;
  });
  await passo("preparar recuperações aguardando", async () => {
    const r = await prepararRecuperacoesAguardando(admin, agora);
    recuperacoes.promovidas = r.promovidas;
    recuperacoes.canceladas = r.canceladas;
  });
  let operantes: string[] = [];
  await passo("listar organizações operantes", async () => {
    operantes = await organizacoesOperantes(admin);
  });
  for (const organizationId of operantes) {
    await passo("fechar avisos de cliente respondido", async () => {
      recuperacoes.avisosFechados += await fecharAvisosDeClienteRespondido(admin, organizationId);
    });
  }

  const prazo = Date.now() + PRAZO_DA_CHAMADA_MS;
  const { data, error } = await admin
    .from("importacoes_de_historico")
    .select("id, organization_id, channel_session_id, cursor, updated_at, organizations:organization_id!inner(status)")
    .eq("status", "rodando")
    .eq("organizations.status", STATUS_OPERANTE)
    .order("updated_at", { ascending: true })
    .limit(LOTE);
  if (error) {
    logger.error("[historico-import] leitura falhou", { detail: error.message, requestId });
    return fail("internal_error", error.message, 500, { requestId });
  }

  const linhas = ((data ?? []) as Linha[]).filter((l) => ehOperante(statusDaOrgEmbutida(l.organizations)));
  let rodadas = 0;
  let puladas = 0;
  let falhas = 0;
  const status: Record<string, number> = {};

  for (const l of linhas) {
    // Sem tempo para uma chamada ao canal, a rodada não avançaria: nem trava.
    if (prazo - Date.now() < MARGEM_PARA_CHAMADA_MS) break;
    if (travada(l.cursor, Date.now())) {
      puladas++;
      continue;
    }
    const agora = new Date();
    const { data: travou, error: erroDaTrava } = await admin
      .from("importacoes_de_historico")
      .update({
        cursor: { ...(l.cursor ?? {}), trava_ate: new Date(agora.getTime() + TRAVA_MS).toISOString() },
        updated_at: agora.toISOString(),
      } as never)
      .eq("id", l.id)
      .eq("organization_id", l.organization_id)
      .eq("status", "rodando")
      .eq("updated_at", l.updated_at)
      .select("id");
    if (erroDaTrava || (travou ?? []).length === 0) {
      puladas++;
      continue;
    }

    rodadas++;
    try {
      const r = await rodarUmaRodada(admin, l.id, TETO_PADRAO, { prazo });
      status[r.status] = (status[r.status] ?? 0) + 1;
      if (r.status === "concluida" || r.status === "erro") {
        void audit({
          action: r.status === "concluida" ? "channel.historico_import_completed" : "channel.historico_import_failed",
          organizationId: l.organization_id,
          resourceType: "channel_session",
          resourceId: l.channel_session_id,
          bypassedRls: true,
          metadata: { importacao_id: l.id, gravadas_na_rodada: r.gravadas },
          requestId,
        });
      }
    } catch (err) {
      // A rodada guarda o próprio erro na linha; o que chega aqui é o que ela
      // não conseguiu nem ler/gravar. A trava vence sozinha em TRAVA_MS.
      falhas++;
      logger.warn("[historico-import] rodada falhou", {
        importacaoId: l.id,
        detail: err instanceof Error ? err.message : "erro",
        requestId,
      });
    }
  }

  return ok({ encontradas: linhas.length, rodadas, puladas, falhas, status, recuperacoes }, { requestId });
}

export const GET = handle;
export const POST = handle;
