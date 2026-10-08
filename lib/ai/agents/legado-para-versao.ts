/**
 * A ponte do corpo LEGADO para o formato de versão — o que faz deixar de criar
 * `rag_bot` (issue #1357).
 *
 * Duas portas gravavam agente direto em `ai_agents`, sem NENHUMA linha em
 * `ai_agent_versions`: o "Modo A" da API REST (`POST /api/v1/ai/agents` com
 * corpo sem `version`) e a duplicação de um `rag_bot` legado
 * (`lib/ai/agents/duplicate.ts`). Ambas nasciam `kind='rag_bot'` pelo DEFAULT da
 * coluna, e isso não era só uma etiqueta: os dois runtimes atuais resolvem o
 * agente por `join ai_agent_versions v on v.id = a.published_version_id`
 * (`lib/agent-engine/agent/agent-config.ts:252`), então um agente sem versão é
 * invisível para o CRM e para o agent-engine — a única saída era a recuperação
 * legada da tela.
 *
 * O formato legado já traz tudo que a v1 precisa para nascer:
 *
 * - `system_prompt` é o MESMO texto que a versão publicada usaria;
 * - `model` vem no formato `provedor/modelo` (`ai_agents.model`, DEFAULT
 *   `anthropic/claude-sonnet-4-6`) — a coluna `ai_agents.model` foi escrita
 *   com essa barra desde o começo, então partir na primeira barra desfaz o que
 *   a própria criação concatenou, sem adivinhar nada.
 *
 * Os dois campos que o formato legado nunca conheceu vêm em `null`, que são os
 * significados já estabelecidos pelo produto e não "não sei":
 *
 * - `credential_id: null` = usar a chave que veio na INSTALAÇÃO (a mesma
 *   semântica documentada em `versionShapeSchema`, e o caso mais comum do kit);
 * - `channel_session_id: null` = ainda sem número escolhido — publicar sem
 *   número continua sendo recusado, como sempre foi.
 *
 * Todos os OUTROS campos (budgets, handoff, follow-up, operador, escopo) vêm dos
 * `.default(...)` do `versionShapeSchema`, que é o mesmo pelo qual o formulário
 * da tela valida uma v1 — os defaults da versão são os mesmos. A receita das
 * linhas é a de `mcpAgentDraftRecords` (a do corpo com `version`); a tela grava
 * pelo seu próprio insert (`createMcpAgentAction`).
 *
 * NÃO toca em dado nenhum: converte o corpo no MOMENTO da escrita. Agentes
 * `kind='rag_bot'` que já existem seguem intocados e seguem funcionando pela
 * recuperação legada (`LegacyRecovery` + `/reconcile`).
 */
import type { VersionInput } from "@/lib/ai/agents/validation";

/**
 * Provedor adotado quando o `model` legado não traz barra.
 *
 * É o default do produto (todo o `AGENT_MODELS` é `anthropic/...`, e
 * `provedorDaInstalacao` cai em `"anthropic"`), não um chute: a coluna nasceu
 * com `DEFAULT 'anthropic/claude-sonnet-4-6'`, então na prática este ramo só
 * alcança `model` gravado por código antigo sem a barra.
 */
const PROVEDOR_PADRAO = "anthropic";

/**
 * Do formato legado (`ai_agents.system_prompt` + `ai_agents.model`) ao `version`
 * que o caminho único exige.
 *
 * Sai como `Partial<VersionInput>` de propósito: quem completa os defaults é a
 * validação de forma inteira do `agentMcpCreateSchema`, a mesma que roda para
 * criar pela tela e pela API — aqui só se monta a ponte.
 */
export function corpoLegadoParaVersao(
  origem: { system_prompt: string | null; model?: string | null },
): Partial<VersionInput> {
  const bruto = origem.model?.trim() || `${PROVEDOR_PADRAO}/claude-sonnet-4-6`;
  const corte = bruto.indexOf("/");
  return {
    system_prompt: origem.system_prompt?.trim() || "",
    provider: (corte > 0 ? bruto.slice(0, corte) : PROVEDOR_PADRAO) as VersionInput["provider"],
    model: corte > 0 ? bruto.slice(corte + 1) : bruto,
    credential_id: null,
    channel_session_id: null,
  };
}

/**
 * O MESMO resultado, já no corpo que `agentMcpCreateSchema` aceita — é o que o
 * Modo A da API e a duplicação legada mandam para o caminho único.
 *
 * `name`/`description`/`priority` vêm de fora porque são do AGENTE, não da
 * versão; os dois formatos de criação legados os têm.
 */
export function corpoLegadoComoCorpoDeCriacao(
  origem: {
    system_prompt: string | null;
    model?: string | null;
    name: string;
    description?: string | null;
    priority?: number;
  },
) {
  return {
    name: origem.name,
    description: origem.description ?? undefined,
    priority: origem.priority ?? 0,
    version: corpoLegadoParaVersao(origem),
  };
}
