/**
 * O SEAM DO PONTO — onde o System One encosta no resto do sistema.
 *
 * ═══ POR QUE ESTE LADO, E NÃO O `runModelCall` ═══
 *
 * O relatório em `docs/research/2026-09-19-jev-system-one-no-deskcomm.md` desenhou
 * um `runDecisionCall` espelhando `runModelCall`. Ao implementar, o repo corrigiu o
 * desenho: há DUAS pilhas, e o próprio `lib/ai/gateway-binding.ts` já documenta a
 * divisão — o seam do agente fala `pg.Pool`, e os workers do Next falam Supabase.
 *
 * O primeiro ponto a ser ligado (`sentiment_classify`, escolhido por rodar fora do
 * caminho crítico e por já falhar em silêncio por desenho) vive na pilha do Next.
 * Seguir o ponto onde ele está é mais honesto que arrastar o ponto até o desenho:
 * a versão `pg.Pool` nasce quando um ponto do agent-engine for ligado, e as duas
 * compartilham o cliente (`./cliente`), que é onde mora o contrato do fornecedor.
 *
 * ═══ O QUE ELE GARANTE ═══
 *
 *  1. **Sem credencial, nada sai da máquina.** A ausência é configuração, não
 *     incidente: o caminho atual assume no mesmo milissegundo, sem gastar
 *     requisição nem esperar timeout.
 *  2. **O destino passa pela allowlist de egress** (F4-03), com o host vindo da
 *     config — nunca um `fetch` cru. Host fora dela falha FECHADO, como todo
 *     egress do runtime.
 *  3. **Nunca lança.** Egress bloqueado, fornecedor fora do ar, resposta ilegível:
 *     tudo chega a quem chamou como `{ ok: false, motivo }`.
 *
 * ═══ O QUE ELE NÃO FAZ ═══
 *
 * Fora o interruptor do administrador (que é consentimento, não estratégia — ver
 * `chaveDaOrganizacao`), não decide se o fornecedor DEVE ser usado, e não conhece
 * o fallback. Isso é do call site, que é quem sabe o que fazer quando a resposta
 * não vem — e é por isso que o resultado é discriminado em vez de um valor com
 * default.
 */
import { allowlistedFetch, buildAllowlist } from "@/lib/agent-engine/edge/egress";
import { byteaToBuffer, decryptKey } from "@/lib/crypto/aes_gcm";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

import { baseDaApiDoJev, decidir, type Pergunta, type ResultadoDaDecisao } from "./cliente";
import { lerConfigDoJev } from "./config";
import { PROVEDOR_DO_JEV } from "./credencial";

export interface EntradaDoPonto {
  /** O ponto de IA, como no registro (`lib/ai/pontos/registro.ts`). Vai à telemetria. */
  ponto: string;
  organizationId: string;
  estado: string | Record<string, unknown> | ReadonlyArray<unknown>;
  perguntas: Record<string, Pergunta>;
  tetoMs?: number;
}

export interface DependenciasDoPonto {
  /** Resolve a chave do fornecedor PARA AQUELA organização. `null` = não configurado. */
  buscarChave?: (organizationId: string) => Promise<string | null>;
  fetchImpl?: typeof fetch;
  /** Base da API. Default: `baseDaApiDoJev()`. A allowlist deriva dela. */
  baseUrl?: string;
  /** Allowlist de egress. O default é o host da base. */
  hostsPermitidos?: readonly string[];
}

/**
 * A chave do Jev DAQUELA organização: a credencial `typesafe` ativa e validada
 * mais recente. Nunca uma chave de ambiente global — seria o contrário do BYOK,
 * e uma instalação pagaria a conta de outra. A mesma regra, sobre linhas já
 * lidas, é `credencialEmUsoPeloJev` (`./credencial.ts`): mudar uma é mudar a outra.
 *
 * "Validada" é a convenção de todo leitor de chave do repo
 * (`lib/ai/gateway-binding.ts`): chave colada e ainda não conferida não sai
 * para a rede.
 *
 * **Só com o interruptor ligado** (`settings.jev`, que exige o aceite do
 * administrador). Cadastrar a chave não é consentir: sem esta guarda, colar a
 * chave em Credenciais já mandava cada mensagem recebida ao fornecedor
 * estrangeiro, sem ninguém ter ligado nada (LGPD). A guarda mora AQUI, e não em
 * cada chamador, porque todo caminho até a rede passa por esta leitura. O
 * interruptor é lido primeiro: desligado é o estado de toda instalação, e custa
 * uma consulta só.
 *
 * Nunca lança. Leitura que falha devolve `null` e o chamador segue pelo caminho
 * de sempre — mas deixa rastro, porque sem ele uma decifragem quebrada é
 * indistinguível de "não cadastrou a chave". O log leva só a CLASSE do erro: a
 * mensagem pode carregar material da credencial.
 */
export async function chaveDaOrganizacao(organizationId: string): Promise<string | null> {
  try {
    // Admin client passa por cima da RLS: o filtro por organização é
    // PROGRAMÁTICO e obrigatório (CLAUDE.md, anti-pattern 10).
    const admin = createAdminClient();
    const { data: org, error: orgErr } = await admin
      .from("organizations")
      .select("settings")
      .eq("id", organizationId)
      .maybeSingle();
    if (orgErr) throw orgErr;
    if (!lerConfigDoJev(org?.settings).ligado) return null;

    const { data, error } = await admin
      .from("ai_provider_credentials")
      .select("api_key_encrypted, api_key_iv, api_key_tag")
      .eq("organization_id", organizationId)
      .eq("provider", PROVEDOR_DO_JEV)
      .eq("is_active", true)
      .not("validated_at", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return decryptKey({
      ciphertext: byteaToBuffer(data.api_key_encrypted),
      iv: byteaToBuffer(data.api_key_iv),
      tag: byteaToBuffer(data.api_key_tag),
    });
  } catch (erro) {
    logger.warn("chave do Jev não pôde ser lida; seguindo pelo caminho de sempre", {
      organizationId,
      erro: erro instanceof Error ? erro.name : typeof erro,
    });
    return null;
  }
}

export async function decidirNoPonto(
  entrada: EntradaDoPonto,
  deps: DependenciasDoPonto = {},
): Promise<ResultadoDaDecisao> {
  const chave = await (deps.buscarChave ?? chaveDaOrganizacao)(entrada.organizationId);
  if (chave === null || chave.trim() === "") {
    return { ok: false, motivo: "sem_credencial", exigeAcao: false, defeitoNosso: false, status: null };
  }

  const base = deps.baseUrl ?? baseDaApiDoJev();
  const allowlist = buildAllowlist([...(deps.hostsPermitidos ?? [base])]);
  const fetchContido: typeof fetch = (input, init) =>
    allowlistedFetch(
      typeof input === "string" || input instanceof URL ? input : input.url,
      init,
      { allowlist, fetchImpl: deps.fetchImpl, log: logger },
    );

  return decidir(
    {
      chave,
      estado: entrada.estado,
      perguntas: entrada.perguntas,
      ...(entrada.tetoMs !== undefined ? { tetoMs: entrada.tetoMs } : {}),
    },
    { fetchImpl: fetchContido, baseUrl: base },
  );
}
