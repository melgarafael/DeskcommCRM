/**
 * Mudar as CONFIGURAÇÕES de um assistente num rascunho — puro, sem banco.
 *
 * Complementa `editar-prompt.ts`: o texto das instruções e as chaves do
 * assistente (modelo, voz, ferramentas, quando passar para uma pessoa, dividir
 * mensagens, ver imagens) mudam pelo mesmo caminho — um rascunho que a tela
 * reabre, testa e publica. A régua final é a da tela (`versionCreateSchema` e a
 * publicação); aqui só se recusa ANTES, com motivo legível, o que ela recusaria
 * com um erro genérico, e o que nenhuma tela deixaria: dar a um assistente uma
 * ferramenta que é só do administrador.
 *
 * O que fica DE FORA de propósito (decisão do dono, 17/11/2026): número/canal
 * do assistente, credencial (chave de IA), funis e materiais — ou mexem em
 * conexão e segredo, ou têm tela própria.
 */
import { validarParProvedorModelo } from "@/lib/ai/par-provedor-modelo";
import { VALID_TOOL_IDS } from "@/lib/mcp/tools/catalog";
import { IDS_DO_ADMINISTRADOR } from "@/lib/mcp/tools/ferramentas-do-administrador";
import { TETO_TOOLS_POR_AGENTE } from "@/lib/mcp/tools/selecao-por-pacote";

import type { LinhaDaVersao } from "./linha-da-versao";

export const QUANDO_VOZ = ["nunca", "espelhar", "sempre", "quando_pede"] as const;

export interface ConfiguracoesDoRascunho {
  provedor?: string;
  modelo?: string;
  voz_ligada?: boolean;
  voz_quando?: (typeof QUANDO_VOZ)[number];
  ferramentas_adicionar?: string[];
  ferramentas_remover?: string[];
  palavras_para_humano?: string[];
  pode_chamar_humano?: boolean;
  assunto_juridico_para_humano?: boolean;
  dividir_mensagens?: boolean;
  tamanho_maximo_da_parte?: number;
  ver_imagens?: boolean;
}

export type ResultadoDasConfiguracoes =
  | { ok: true; linha: LinhaDaVersao; mudancas: string[] }
  | { ok: false; motivo: string; mensagem: string };

function igual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function aplicarConfiguracoes(base: LinhaDaVersao, c: ConfiguracoesDoRascunho): ResultadoDasConfiguracoes {
  const linha: LinhaDaVersao = { ...base };
  const mudancas: string[] = [];
  const trocar = <K extends keyof LinhaDaVersao>(campo: K, valor: LinhaDaVersao[K], rotulo: string) => {
    if (!igual(linha[campo], valor)) {
      linha[campo] = valor;
      mudancas.push(rotulo);
    }
  };

  if (c.provedor !== undefined || c.modelo !== undefined) {
    const provedor = c.provedor ?? base.provider;
    const modelo = c.modelo ?? base.model;
    const par = validarParProvedorModelo(provedor, modelo);
    if (!par.valido) {
      return { ok: false, motivo: "modelo_invalido", mensagem: `Model "${modelo}" does not match provider "${provedor}": ${par.motivo}.` };
    }
    trocar("provider", provedor, "provedor");
    trocar("model", modelo, "modelo");
  }

  if (c.voz_ligada !== undefined) trocar("voz_enabled", c.voz_ligada, "voz_ligada");
  if (c.voz_quando !== undefined) trocar("voz_quando", c.voz_quando, "voz_quando");

  if (c.ferramentas_adicionar?.length || c.ferramentas_remover?.length) {
    const validas = new Set<string>(VALID_TOOL_IDS as readonly string[]);
    const desconhecidas = (c.ferramentas_adicionar ?? []).filter((t) => !validas.has(t));
    if (desconhecidas.length) {
      return { ok: false, motivo: "ferramenta_desconhecida", mensagem: `Unknown tool ids: ${desconhecidas.join(", ")}.` };
    }
    const doAdministrador = (c.ferramentas_adicionar ?? []).filter((t) => IDS_DO_ADMINISTRADOR.has(t));
    if (doAdministrador.length) {
      return {
        ok: false,
        motivo: "ferramenta_so_do_administrador",
        mensagem: `These tools are for the administrator only and cannot be given to an assistant: ${doAdministrador.join(", ")}.`,
      };
    }
    const remover = new Set(c.ferramentas_remover ?? []);
    const atual = (base.tool_ids ?? []).filter((t) => !remover.has(t));
    for (const t of c.ferramentas_adicionar ?? []) if (!atual.includes(t)) atual.push(t);
    if (atual.length > TETO_TOOLS_POR_AGENTE) {
      return {
        ok: false,
        motivo: "ferramentas_demais",
        mensagem: `An assistant can have at most ${TETO_TOOLS_POR_AGENTE} tools; this change would leave ${atual.length}. Remove some in the same change.`,
      };
    }
    trocar("tool_ids", atual, "ferramentas");
  }

  if (c.palavras_para_humano !== undefined) trocar("handoff_keywords", c.palavras_para_humano, "palavras_para_humano");
  if (c.pode_chamar_humano !== undefined) trocar("handoff_tool_enabled", c.pode_chamar_humano, "pode_chamar_humano");
  if (c.assunto_juridico_para_humano !== undefined) {
    trocar("handoff_legal_enabled", c.assunto_juridico_para_humano, "assunto_juridico_para_humano");
  }
  if (c.dividir_mensagens !== undefined) trocar("split_messages", c.dividir_mensagens, "dividir_mensagens");
  if (c.tamanho_maximo_da_parte !== undefined) trocar("split_max_chars", c.tamanho_maximo_da_parte, "tamanho_maximo_da_parte");
  if (c.ver_imagens !== undefined) trocar("image_vision_enabled", c.ver_imagens, "ver_imagens");

  return { ok: true, linha, mudancas };
}
