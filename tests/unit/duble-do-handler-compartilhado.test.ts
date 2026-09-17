import { describe, expect, it } from "vitest";

import { criarDubleDoHandler } from "@/tests/helpers/duble-do-handler";

describe("dublê compartilhado do sendMessageHandler", () => {
  it("aceita filtros sem limite, é aguardável e registra patch + tenant filters", async () => {
    const { supabase, capturas } = criarDubleDoHandler({ conversation: { id: "conv-1" } });

    const resultado = await supabase
      .from("contacts")
      .update({ last_activity_at: "2026-09-17T00:00:00.000Z" })
      .eq("id", "contact-1")
      .eq("organization_id", "org-1")
      .eq("future_guard", true);

    expect(resultado.error).toBeNull();
    expect(capturas.patches.contacts).toEqual([
      { last_activity_at: "2026-09-17T00:00:00.000Z" },
    ]);
    expect(capturas.filtros.contacts).toEqual([
      { coluna: "id", valor: "contact-1" },
      { coluna: "organization_id", valor: "org-1" },
      { coluna: "future_guard", valor: true },
    ]);
  });

  it("registra update de conversa sem impor quantidade de filtros", async () => {
    const { supabase, capturas } = criarDubleDoHandler({ conversation: { id: "conv-1" } });

    const resultado = await supabase
      .from("conversations")
      .update({ unread_count_for_assignee: 0 })
      .eq("id", "conv-1")
      .eq("organization_id", "org-1");

    expect(resultado.error).toBeNull();
    expect(capturas.patches.conversations).toEqual([{ unread_count_for_assignee: 0 }]);
    expect(capturas.filtros.conversations).toHaveLength(2);
  });
});
