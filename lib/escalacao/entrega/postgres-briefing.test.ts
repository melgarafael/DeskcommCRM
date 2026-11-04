import { describe, it, expect, vi } from "vitest";
import type pg from "pg";
import { carregarPassagem } from "./postgres";
import { textoCurtoDaPassagem } from "./passagem";

describe("passagem atual para o aviso", () => {
  it("usa identidade e campos estruturados, não body narrativo nem transcript", async () => {
    const query = vi.fn(async (..._args: unknown[]) => ({
      rows: [
        {
          conversation_id: "conversation",
          lead_id: "lead",
          service_revision: 2,
          contact_name: "Cliente sintético",
          contact_phone: "+5511000000001",
          title: "Quer avaliar troca",
          body: "Por que IA passou: texto que não deve sair",
          notes: "Quero falar com alguém",
          tentativas: [
            { o_que: "Enviei fotos", desfecho: "Gostou" },
            { o_que: "Registrou troca" },
            { o_que: 3 },
          ],
        },
      ],
    }));
    const pool = { query } as unknown as pg.Pool;
    const p = await carregarPassagem(pool, "org-A", "episode-A");
    expect(query.mock.calls[0]).toEqual([
      expect.stringContaining("ct.organization_id=e.organization_id"),
      ["org-A", "episode-A"],
    ]);
    expect(query.mock.calls[0]?.[0]).toContain("ct.anonymized_at is null");
    expect(p?.resumo).toMatchObject({
      nome: "Cliente sintético",
      telefone: "+5511000000001",
      interesse: "Quer avaliar troca",
      tentativas: ["Enviei fotos → Gostou", "Registrou troca"],
      ultimasPalavras: "Quero falar com alguém",
    });
    const text = textoCurtoDaPassagem(p!, "https://crm.example.com", "both");
    expect(text).not.toMatch(/Por que IA passou|undefined|texto que não deve sair/);
    expect(text).toContain("wa.me/5511000000001");
  });
  it("passagem/contato ausente ou anonimizado não cria identidade", async () => {
    const query = vi.fn(async (..._args: unknown[]) => ({ rows: [] }));
    expect(
      await carregarPassagem({ query } as unknown as pg.Pool, "org-B", "episode-B"),
    ).toBeNull();
  });
  it("sem campos opcionais mantém aviso utilizável sem body fallback", async () => {
    const query = vi.fn(async (..._args: unknown[]) => ({
      rows: [
        {
          conversation_id: "conversation",
          service_revision: 1,
          tentativas: "broken",
          body: "narrativa antiga",
        },
      ],
    }));
    const p = await carregarPassagem({ query } as unknown as pg.Pool, "org-A", "episode-A");
    expect(textoCurtoDaPassagem(p!, "https://crm.example.com", "whatsapp")).toBe(
      "📋 *Novo atendimento*\n\n👤 *Responsável:* Responsável definido no CRM\n\n🔗 *Abrir atendimento no CRM:*\nhttps://crm.example.com/app/inbox?id=conversation",
    );
  });
});
