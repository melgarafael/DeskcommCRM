/**
 * O MOTIVO DE GANHO QUE O FUNIL OFERECE — lido do `settings`, não inventado
 * (issue #5181).
 *
 * ─── O defeito que este arquivo fecha ──────────────────────────────────────
 *
 * O servidor já sabia tudo: `POST /leads/[id]/win` aceita `won_reason` no
 * corpo, `encerraDemanda` cobra o motivo quando `settings.won_reason_required`
 * está ligado, e `recusaDeMotivoDoGanho` (`lib/leads/campos-exigidos.ts`)
 * recusa o texto que não está em `settings.won_reasons`. A TELA, sozinha, não
 * perguntava nada: o item "Marcar como ganho" do menu do card mandava
 * `{ leadId }` e o servidor decidia. Quem tinha a lista cadastrada digitava
 * texto livre, confirmava, e só no clique descobria que o motivo era inválido.
 *
 * ─── O que este arquivo NÃO decide ─────────────────────────────────────────
 *
 * Não escreve no banco, não muda a régua e não torna nada obrigatório: a
 * obrigatoriedade continua sendo o opt-in `won_reason_required`, decidido no
 * servidor. Aqui só se LÊ o que está cadastrado e se responde a pergunta que a
 * tela faz antes de fechar: "o que eu ofereço?" — a segunda pergunta ("este
 * valor passa?") continua sendo do servidor, e a tela reage à recusa dele.
 */

import { pipelineConfigPatchSchema } from "@/lib/schemas/settings";

/** O mesmo teto do PATCH (`.max(50)`): acima disso a tela não é lista, é rolagem. */
const MAX_MOTIVOS = 50;

/**
 * Os motivos de ganho cadastrados neste funil, na ordem cadastrada e sem
 * repetição.
 *
 * Cada item passa pela MESMA régua da gravação
 * (`pipelineConfigPatchSchema.shape.won_reasons`), aplicada POR ITEM — um
 * cadastro sujo (um vazio numa lista de seis) não pode derrubar os cinco bons.
 *
 * ⚠️ O RÓTULO É O TEXTO APARADO, e o item que não é igual ao seu próprio
 * `trim()` é DESCARTADO. Não é capricho: `recusaDeMotivoDoGanho` apara o
 * motivo que chega e o compara por IGUALDADE EXATA com o que está gravado
 * (`aceitos.has(motivo)`). Um `won_reasons: [" Renovação "]`, gravado por
 * script ou seed, nunca poderia ser satisfeito por valor nenhum vindo da tela
 * — oferecê-lo seria a mesma mentira que esta issue fecha, só que na primeira
 * opção da lista.
 */
export function motivosDeGanhoDoFunil(settings: unknown): string[] {
  const bruto = (settings as { won_reasons?: unknown } | null | undefined)?.won_reasons;
  if (!Array.isArray(bruto)) return [];

  const regra = pipelineConfigPatchSchema.shape.won_reasons;
  const vistos = new Set<string>();
  const limpos: string[] = [];

  for (const item of bruto) {
    if (typeof item !== "string") continue;
    const texto = item.trim();
    if (texto !== item) continue;
    if (vistos.has(texto)) continue;
    if (!regra.safeParse([texto]).success) continue;
    vistos.add(texto);
    limpos.push(texto);
    if (limpos.length >= MAX_MOTIVOS) break;
  }

  return limpos;
}

/**
 * O funil exige o motivo do ganho? — espelho de leitura de
 * `settings.won_reason_required`, que `validaCamposExigidos` já aplica no
 * servidor. Ausente é DESLIGADO: o "nada mudou" é o padrão do produto.
 */
export function motivoDeGanhoExigido(settings: unknown): boolean {
  return (settings as { won_reason_required?: unknown } | null | undefined)?.won_reason_required === true;
}
