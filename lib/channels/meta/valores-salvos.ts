/**
 * O que pode ficar salvo num modelo, para o operador não colar o mesmo link a
 * cada disparo — e o que NÃO pode.
 *
 * Modelo com cabeçalho de mídia exige o link em TODO envio: a plataforma guarda
 * só a amostra da aprovação. Sem lugar para guardar, fora da janela de 24h o
 * operador colava a mesma URL toda vez, e um link errado uma vez era um envio
 * perdido. A coluna é `meta_templates.saved_values` (migration 0382).
 *
 * ─── Só link de mídia ───────────────────────────────────────────────────────
 * `{{1}}` do corpo costuma ser o nome do cliente. Salvá-lo no modelo mandaria o
 * nome de uma pessoa para a próxima — então a regra aceita só slot de mídia, e
 * a chave é conferida contra o CONTRATO derivado, não contra uma lista escrita
 * à mão: um modelo que troca o cabeçalho de imagem por texto deixa de aceitar
 * link salvo sem que ninguém precise lembrar disso.
 *
 * ─── Valor vazio apaga ──────────────────────────────────────────────────────
 * É o "esquecer o link salvo". Sem isso, a única saída seria salvar outro.
 */
import { slotKey } from "./build-components";
import type { TemplateContract } from "./template-contract";

const MIDIA = new Set(["image", "video", "document"]);

export type MesclaDeValores =
  | { ok: true; valores: Record<string, string> }
  | { ok: false; motivo: "chave_nao_e_midia"; chave: string }
  | { ok: false; motivo: "link_invalido"; chave: string };

/** Link que a plataforma consegue baixar: `https://` com host. */
function ehLinkPublico(valor: string): boolean {
  try {
    const u = new URL(valor);
    return u.protocol === "https:" && u.hostname.length > 0;
  } catch {
    return false;
  }
}

/**
 * Aplica `novos` sobre `atuais` e devolve o que fica salvo.
 *
 * Tudo ou nada: uma chave recusada recusa o pedido inteiro. Salvar metade faria
 * a tela dizer "salvo" para um formulário que ficou pela metade.
 */
export function mesclarValoresSalvos(
  contrato: TemplateContract,
  atuais: Record<string, unknown>,
  novos: Record<string, string>,
): MesclaDeValores {
  const chavesDeMidia = new Set(
    contrato.slots.filter((s) => MIDIA.has(s.expects)).map((s) => slotKey(s.address, s.key)),
  );

  // Só o que ainda é slot de mídia sobrevive: link salvo para um cabeçalho que
  // deixou de ser mídia não pode continuar pré-preenchendo nada.
  const valores: Record<string, string> = {};
  for (const [chave, valor] of Object.entries(atuais)) {
    if (chavesDeMidia.has(chave) && typeof valor === "string") valores[chave] = valor;
  }

  for (const [chave, bruto] of Object.entries(novos)) {
    if (!chavesDeMidia.has(chave)) return { ok: false, motivo: "chave_nao_e_midia", chave };
    const valor = bruto.trim();
    if (valor === "") {
      delete valores[chave];
      continue;
    }
    if (!ehLinkPublico(valor)) return { ok: false, motivo: "link_invalido", chave };
    valores[chave] = valor;
  }

  return { ok: true, valores };
}
