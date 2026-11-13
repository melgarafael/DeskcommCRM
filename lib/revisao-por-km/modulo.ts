/**
 * O PORTÃO DA INSTALAÇÃO da revisão por quilometragem (#4376, adaptação do #4536).
 *
 * A revisão por km é régua de ramo (oficina, concessionária, frota): entra como
 * MÓDULO OPCIONAL da instalação, por flag (`MODULO_REVISAO_POR_KM` em
 * `platform_config`, `lib/instalacao/modulos.ts`), desligado por padrão.
 *
 * Dois níveis, como manda a doutrina:
 *   - a INSTALAÇÃO decide se a régua existe (esta chave);
 *   - a ORGANIZAÇÃO decide em qual funil ela vale (`pipelines.settings.revisao_por_km`).
 * Não há terceira chave em `organizations.settings`: seria outro interruptor para a
 * mesma decisão.
 *
 * O portão mora AQUI, dentro do módulo, e não no sítio de chamada do núcleo: o
 * núcleo chama `armarProximaRevisaoNoCard` / `armarProximaRevisaoPeloFluxo`, e
 * são elas que perguntam se o módulo existe antes de qualquer coisa que custe.
 *
 * FALHA FECHADA: erro de banco, `platform_config` ilegível, valor estranho ou
 * ambiente sem cliente de serviço = DESLIGADO. `moduloLigado` já falha fechado;
 * o `try` aqui cobre o `createAdminClient()` que lança sem as variáveis de ambiente.
 *
 * ─── Por que `createAdminClient()` + `moduloLigadoComMemo`, e não o pool `pg` ───
 *
 * O caminho do roteiro só tem o pool `pg`. O molde por `pg` que existe
 * (`cobrancaLigadaComMemo`) lê por uma função do banco própria da cobrança
 * (`fn_cobranca_ligada`); repeti-lo aqui pediria uma `fn_revisao_por_km_ligada`
 * (migration, o que esta adaptação não tem) ou um `select` cru em `platform_config`
 * — um terceiro jeito de ler chave. O motor do agente já usa
 * `moduloLigadoComMemo(createAdminClient(), …)` para `fluxos_atendimento`
 * (`lib/agent-engine/agent/inbound-turn.ts`), no mesmo processo: é esse o molde.
 */
import { moduloLigado, moduloLigadoComMemo } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";

export const MODULO_REVISAO_POR_KM = "revisao_por_km" as const;

/**
 * Para a porta do CARD (rota): lê a chave a cada vez, como as telas e rotas. Só é
 * chamada depois de o funil ter declarado a régua — PATCH em funil sem régua não
 * paga esta leitura.
 */
export async function revisaoPorKmLigada(): Promise<boolean> {
  try {
    return await moduloLigado(createAdminClient(), MODULO_REVISAO_POR_KM);
  } catch {
    return false;
  }
}

/**
 * Para a porta do ROTEIRO (caminho quente: o turno do agente). Memo de processo de
 * `MEMO_DO_MODULO_MS` (30 s): desligar a chave vale para o roteiro em até 30 s.
 */
export async function revisaoPorKmLigadaComMemo(): Promise<boolean> {
  try {
    return await moduloLigadoComMemo(createAdminClient(), MODULO_REVISAO_POR_KM);
  } catch {
    return false;
  }
}
