/**
 * AS DUAS CAMADAS DE SEGURANÇA QUE CUSTAM DINHEIRO, ESCOLHIDAS POR ORGANIZAÇÃO.
 *
 * ## O que estava errado
 *
 * A cadeia que confere a mensagem antes de sair tem dez verificações. Oito são
 * determinísticas, custam zero e não são escolha de ninguém. Duas consultam um
 * modelo e custam por mensagem — e eram decididas por variável de ambiente do
 * WORKER (`PROMISE_SEMANTIC_ENABLED`, e a presença de
 * `JAILBREAK_CLASSIFIER_MODEL`), montadas UMA VEZ no boot do processo.
 *
 * Por processo significa: igual para todas as organizações da instalação, e
 * alcançável só por quem edita o `.env` da VPS e reinicia o contêiner. Num
 * produto que a pessoa instala sozinha, isso é o mesmo que não existir — e a
 * tela de configuração do agente não tinha como oferecer a escolha sem mentir.
 *
 * ## Três estados, não dois — e é aqui que mora a compatibilidade
 *
 * `null` (sem linha) não é "desligado": é "esta organização não escolheu", e aí
 * vale o ambiente. É o que faz aplicar a migration não mudar o comportamento de
 * ninguém: quem já decidiu no `.env` continua exatamente como estava, e a linha
 * só nasce quando alguém clica.
 *
 * Colapsar isso num booleano com default `false` desligaria as duas camadas de
 * toda instalação que as tinha ligadas, no dia do deploy, em silêncio — é a
 * mesma armadilha de "ausente ≠ vazio" que a declaração do turno tomou o cuidado
 * de não cair.
 */
import type pg from 'pg';

/**
 * O vocabulário vive AQUI, não num CHECK do banco.
 *
 * A coluna `layer` é de vocabulário ABERTO de propósito (CLAUDE.md): um clone com
 * valor que este build não conhece — camada removida, camada de versão futura —
 * quebraria o `update.sh` dele se houvesse constraint. Em troca, o emissor usa
 * esta constante e nunca string literal.
 */
export const CAMADAS_SEMANTICAS = ['promessa_semantica', 'jailbreak'] as const;

export type CamadaSemantica = (typeof CAMADAS_SEMANTICAS)[number];

/** O que a organização escolheu. `null` = não escolheu; vale o ambiente. */
export type EscolhaDeCamadas = Record<CamadaSemantica, boolean | null>;

/** Nenhuma escolha — o estado de toda organização antes de alguém clicar. */
export const SEM_ESCOLHA: EscolhaDeCamadas = { promessa_semantica: null, jailbreak: null };

/**
 * A precedência, isolada em função pura para ser testável sem banco.
 *
 * A organização vence o ambiente quando escolheu; quando não escolheu, o
 * ambiente decide. Uma linha, e ela é a razão de este módulo existir — inverter
 * a ordem faria a tela gravar e o motor ignorar, que é o defeito que este
 * trabalho conserta.
 */
export function camadaLigada(escolhaDaOrg: boolean | null, padraoDoAmbiente: boolean): boolean {
  return escolhaDaOrg ?? padraoDoAmbiente;
}

/**
 * Lê a escolha da organização. Uma query por turno, com as duas camadas juntas.
 *
 * Falha ABERTA para o ambiente: se a leitura estourar (tabela ainda não criada
 * num clone que atualizou o código antes do schema, banco fora do ar por um
 * instante), o turno segue com o padrão do ambiente em vez de derrubar o
 * atendimento. A escolha é deliberada — a alternativa seria um cliente sem
 * resposta por causa de uma preferência de configuração.
 */
export async function lerCamadasDaOrg(db: pg.Pool, organizationId: string): Promise<EscolhaDeCamadas> {
  try {
    const { rows } = await db.query<{ layer: string; enabled: boolean }>(
      `select layer, enabled from org_guardrail_layers where organization_id = $1`,
      [organizationId],
    );
    return escolhaDasLinhas(rows);
  } catch {
    return { ...SEM_ESCOLHA };
  }
}

/** As linhas de `org_guardrail_layers` de UMA organização, como escolha. */
export function escolhaDasLinhas(rows: ReadonlyArray<{ layer: string; enabled: boolean }>): EscolhaDeCamadas {
  const escolha: EscolhaDeCamadas = { ...SEM_ESCOLHA };
  for (const r of rows) {
    // Linha com camada que este build não conhece é ignorada, não é erro: é o
    // preço declarado do vocabulário aberto, e o clone que voltar de versão
    // não perde a linha.
    if ((CAMADAS_SEMANTICAS as readonly string[]).includes(r.layer)) {
      escolha[r.layer as CamadaSemantica] = r.enabled;
    }
  }
  return escolha;
}

/**
 * O padrão do AMBIENTE de cada camada, para quem está FORA do worker (as rotas e
 * telas do servidor web) dizer o que o motor faz.
 *
 *  - `jailbreak`: ligada. O worker monta `knobs.jailbreak` em todo boot
 *    (`turnKnobsFromEnv`, `../agent/turn-knobs.ts`) — `JAILBREAK_CLASSIFIER_MODEL`
 *    só escolhe o modelo —, e o turno roda a camada quando o knob existe. A tela
 *    de Segurança lia a PRESENÇA da variável e dizia "Desligada" a quem pagava a
 *    consulta a cada mensagem. Cobrado contra o `turnKnobsFromEnv` de verdade em
 *    `./camadas-da-org.test.ts`.
 *  - `promessa_semantica`: `PROMISE_SEMANTIC_ENABLED=true`, como a rota da
 *    Segurança sempre leu. ponytail: o worker consulta ANTES o comportamento da
 *    instalação (`promessaSemanticaDaInstalacao`), que esta leitura não vê —
 *    alinhar quando a tela de Segurança precisar dizer isso.
 *
 * ⚠️ O worker é outro processo, com o SEU `.env`: fora dele, isto é a melhor
 * leitura disponível. Assim que a organização escolhe, a linha vence.
 */
export function padraoDasCamadasNoAmbiente(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Record<CamadaSemantica, boolean> {
  return { promessa_semantica: env.PROMISE_SEMANTIC_ENABLED === 'true', jailbreak: true };
}

/** O que vale para a organização, fora do worker: a escolha dela, ou o padrão do ambiente. */
export function camadasEfetivas(
  rows: ReadonlyArray<{ layer: string; enabled: boolean }>,
  padrao: Record<CamadaSemantica, boolean> = padraoDasCamadasNoAmbiente(),
): Record<CamadaSemantica, boolean> {
  const escolha = escolhaDasLinhas(rows);
  return {
    promessa_semantica: camadaLigada(escolha.promessa_semantica, padrao.promessa_semantica),
    jailbreak: camadaLigada(escolha.jailbreak, padrao.jailbreak),
  };
}
