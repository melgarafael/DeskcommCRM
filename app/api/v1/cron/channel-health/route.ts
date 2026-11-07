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
import {
  defeitoDoNumero,
  julgarQueda,
  motivoParaGravar,
  sincronizarSaudeDaConexao,
} from "@/lib/channels/health";
import { normalizarIdioma, type Idioma } from "@/lib/i18n/idiomas";
import { ehNomeDeSessaoE2E } from "@/lib/channels/sessoes-e2e";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { recursoOcioso } from "@/lib/cron/piso-ocioso";

export const dynamic = "force-dynamic";

/** Teto por rodada. Cada sessão é uma chamada de rede ao transporte. */
const LIMITE = 50;

type LinhaDeSessao = ChannelSessionRef & {
  id: string;
  organization_id: string;
  status: string | null;
  /** O porquê de um número de pé com defeito (`motivoParaGravar`); a tela de Conexões o mostra. */
  status_reason: string | null;
  display_name: string | null;
  phone_number: string | null;
  archived_at: string | null;
  /** Observações ruins SEGUIDAS — é onde o anti-pisco guarda a contagem. */
  consecutive_health_fails: number | null;
};

/** Falhou a leitura, o aviso sai em português — nunca deixa de sair. */
async function idiomaDaOrganizacao(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
): Promise<Idioma> {
  const { data } = await admin.from("organizations").select("locale").eq("id", organizationId).maybeSingle();
  return normalizarIdioma((data as { locale?: string | null } | null)?.locale);
}

/**
 * O QUE RODA DEPOIS DO PORTÃO DO PISO OCIOSO (#3773), na ordem do arquivo.
 *
 * O portão abaixo é saída antecipada da ROTA INTEIRA: em instalação ociosa a
 * rota sai antes de tudo isto. `tests/unit/cron-passa-pelo-portao.test.ts` lê o
 * AST deste arquivo e reprova quando o que está de fato abaixo do portão diverge
 * desta lista — passo novo que não roda na instalação parada não pode nascer
 * sem alguém ver.
 */
const PASSOS_DEPOIS_DO_PORTAO = [
  "const admin",
  "const {data, error}",
  "if (error)",
  "const sessoes",
  "let verificadas",
  "const desfechos",
  "let ignoradas",
  "for (s of sessoes)",
  "return",
] as const;
void PASSOS_DEPOIS_DO_PORTAO;

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  // O PISO OCIOSO (#3731): Sem sessão de canal ativa não há saúde de canal a vigiar.
  // A saída vem antes de qualquer consulta da rodada, e o portão responde de um
  // retrato em memória (`lib/cron/piso-ocioso.ts`): esta rota ia ao PostgREST a
  // cada batida só para descobrir que a fila está vazia.
  if (await recursoOcioso("canal_vigiado")) return ok({ pulado: "recurso_ocioso" }, { requestId });

  const admin = createAdminClient();

  // Arquivada não é vigiada: ela foi desligada de propósito, e avisar que uma
  // conexão aposentada está parada é exatamente o ruído que faz o operador
  // ignorar a Central.
  const { data, error } = await admin
    .from("channel_sessions")
    .select(
      `id, organization_id, status, status_reason, display_name, phone_number, archived_at, consecutive_health_fails, ${CHANNEL_SESSION_REF_COLUMNS}`,
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
      // Sessão de teste não é conexão de ninguém (#1032): os seeds do e2e
      // gravam em `channel_sessions` e nada apaga a linha, então ela continua
      // aqui entre uma suíte e outra — parada, num status que abre aviso. A
      // pergunta abaixo transformaria esse resíduo de teste em alarme
      // permanente na Central de quem opera, e é o alarme que ninguém lê que
      // faz o alarme verdadeiro deixar de ser lido.
      //
      // O nome vem do seam (`resolveSessionRef`), como no resto do vigia: a
      // rota continua sem nomear coluna nem provedor, e a lista é a MESMA que a
      // limpeza de fim de suíte apaga — uma segunda cópia envelheceria ao lado
      // da primeira e passaria verde sozinha.
      const sessionRef = resolveSessionRef(s);
      if (ehNomeDeSessaoE2E(sessionRef)) {
        ignoradas++;
        continue;
      }

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
      if (!adapter.checkHealth || !sessionRef) continue;

      const saude = await adapter.checkHealth({
        organizationId: s.organization_id,
        sessionRef,
      });
      verificadas++;

      // ─── UMA pergunta que falha não é uma conexão caída ──────────────────
      //
      // Medido: a conexão oficial piscou por 5 minutos e as duas mensagens
      // mandadas nesse intervalo ficaram em `queued` para sempre. Não houve
      // queda — a pergunta ao provedor falhou uma vez.
      //
      // Queda só vale depois de CONFIRMACOES_PARA_QUEDA observações seguidas.
      // Recuperação, não: uma observação boa zera na hora, porque demorar a
      // acreditar na volta segue barrando envio de um canal que já voltou. O
      // contador só é escrito quando muda: a rodada comum (de pé, contador
      // zero) não paga uma escrita por sessão.
      const contadorAnterior = s.consecutive_health_fails ?? 0;
      const julgamento = julgarQueda(saude, contadorAnterior);
      if (julgamento.contador !== contadorAnterior) {
        await admin
          .from("channel_sessions")
          .update({ consecutive_health_fails: julgamento.contador })
          .eq("id", s.id)
          .eq("organization_id", s.organization_id);
      }

      // Enquanto não confirma, o mundo segue como estava: nem status novo no
      // banco, nem aviso. É o pisco sendo absorvido.
      if (julgamento.contador > 0 && !julgamento.confirmada) {
        desfechos.aguardando_confirmacao = (desfechos.aguardando_confirmacao ?? 0) + 1;
        continue;
      }

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

      // O número de pé com defeito (não recebe, envio restrito) não muda de
      // status — barrar o envio seria pior —, então o defeito vai para o
      // motivo, que a tela de Conexões mostra. Só o motivo que esta regra
      // escreve é tocado (`motivoParaGravar`).
      const motivo = motivoParaGravar(saude, s.status_reason);
      if (motivo !== undefined) {
        await admin
          .from("channel_sessions")
          .update({ status_reason: motivo })
          .eq("id", s.id)
          .eq("organization_id", s.organization_id);
      }

      const apelido = s.display_name ?? s.phone_number ?? "sem nome";
      const desfecho = await sincronizarSaudeDaConexao(
        admin,
        { id: s.id, organization_id: s.organization_id, status: statusFinal, status_reason: s.status_reason },
        saude,
        apelido,
        "varredura",
        // O aviso do número de pé com defeito sai no idioma da organização. A
        // leitura só acontece nesse caso, que é raro — a rodada comum não paga
        // uma consulta a mais por sessão.
        defeitoDoNumero(saude.detail) ? await idiomaDaOrganizacao(admin, s.organization_id) : "pt-BR",
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
