/**
 * O título do aviso de passagem na Central nasce no idioma da ORGANIZAÇÃO.
 *
 * A lista da Central mostra o título como foi gravado — nunca por t() (ver o
 * comentário em `app/app/ai/inbox/_components/AgentInboxList.tsx`). Então quem
 * grava tem de gravar traduzido. Medido numa loja em espanhol (26/09/2026): a
 * Central dizia "Atendimento automático parou — assumir a conversa".
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { traduzir } from "@/lib/i18n/dicionario";

const TITULOS = [
  { arquivo: "lib/ai/handoff/orchestrator.ts", titulo: "Atendimento automático parou — assumir a conversa" },
  { arquivo: "lib/agent-engine/agent/human-handoff.ts", titulo: "Handoff humano solicitado — assumir a conversa" },
];

describe("título do aviso de passagem na Central", () => {
  for (const { arquivo, titulo } of TITULOS) {
    it(`${arquivo}: grava o título pelo dicionário, no idioma da organização`, () => {
      const fonte = readFileSync(arquivo, "utf8");
      const escapado = titulo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      expect(fonte).toMatch(new RegExp(`traduzir\\(\\s*['"]${escapado}['"]`));
    });

    it(`"${titulo}" tem tradução para espanhol`, () => {
      const es = traduzir(titulo, "es");
      expect(es).not.toBe(titulo);
      expect(es).not.toMatch(/\b(assumir|atendimento|conversa)\b/);
    });
  }
});
