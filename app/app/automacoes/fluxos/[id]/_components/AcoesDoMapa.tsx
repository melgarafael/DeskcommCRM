"use client";

import { createContext, useContext } from "react";

import type { NodeType } from "@/lib/followup/graph-schema";

import type { NodeVisual } from "./nodes/nodeVisuals";

/**
 * O que o cartão de um bloco pode pedir ao mapa (Automações, estilo ManyChat):
 * criar o próximo bloco já ligado à saída clicada, e duplicar o bloco.
 *
 * Contexto em vez de props porque o cartão é desenhado pelo React Flow
 * (`nodeTypes`), que não deixa passar callback do mapa. Sem provedor (cartão
 * desenhado fora do editor, ex.: teste de componente), o "+" não aparece.
 */
export interface AcoesDoMapa {
  /** Cria um bloco do tipo escolhido e liga a saída `ramo` (ou a única saída, `null`) a ele. */
  adicionarDepois: (nodeId: string, ramo: string | null, tipo: NodeType) => void;
  /** Os blocos que este fluxo aceita — a mesma lista da paleta. */
  tipos: readonly NodeVisual[];
  /** Notas do mapa: o texto é editado no próprio cartão amarelo. */
  editarNota: (id: string, texto: string) => void;
  removerNota: (id: string) => void;
}

export const AcoesDoMapaContext = createContext<AcoesDoMapa | null>(null);

export function useAcoesDoMapa(): AcoesDoMapa | null {
  return useContext(AcoesDoMapaContext);
}
