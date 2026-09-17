/**
 * Mede o prefixo do turno (system + schemas + abertura) SEM chamar Anthropic e
 * SEM decifrar credencial. Compara o conjunto antigo de nativas com o conjunto
 * condicional da FAQ "o que é o Sigilium?".
 *
 *   pnpm exec tsx scripts/ops-count-prefix.ts
 */
import { compararFaqSigilium, FAQ_SIGILIUM } from "../lib/agent-engine/agent/medir-prefixo";
import { nativasDoTurno } from "../lib/agent-engine/agent/nativas-do-turno";

async function main(): Promise<void> {
  const cmp = await compararFaqSigilium();
  const oferecidas = nativasDoTurno(FAQ_SIGILIUM);
  const linhas = [
    "ops-count-prefix — FAQ Sigilium (fixture, sem provedor)",
    "",
    `tools antes:  ${cmp.antes.tools.join(", ")}`,
    `tools depois: ${cmp.depois.tools.join(", ")}`,
    `oferecidas:   ${oferecidas.join(", ")}`,
    "",
    `system:   ${cmp.depois.system_chars} chars / ~${cmp.depois.system_tokens} tok`,
    `schemas antes:  ${cmp.antes.tools_chars} chars / ~${cmp.antes.tools_tokens} tok`,
    `schemas depois: ${cmp.depois.tools_chars} chars / ~${cmp.depois.tools_tokens} tok`,
    `abertura: ${cmp.depois.opening_chars} chars / ~${cmp.depois.opening_tokens} tok`,
    "",
    `por passo antes:  ~${cmp.antes.per_step_tokens} tok`,
    `por passo depois: ~${cmp.depois.per_step_tokens} tok`,
    `redução por passo: ~${cmp.reducao_tokens_por_passo} tok (${(cmp.reducao_pct * 100).toFixed(1)}%)`,
  ];
  process.stdout.write(linhas.join("\n") + "\n");
}

void main();
