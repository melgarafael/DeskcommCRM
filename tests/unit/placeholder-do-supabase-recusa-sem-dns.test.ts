import { describe, expect, it, vi } from "vitest";

/**
 * O PLACEHOLDER DO SUPABASE RECUSA NO MESMO TIQUE — e o audit solto termina
 * enquanto o teste que o disparou ainda está vivo.
 *
 * O porquê está em `tests/setup/vitest.setup.ts` ("O placeholder falha NA
 * HORA"): o `void audit(...)` dos handlers ia ao DNS de `.invalid`, e o
 * `console.error` da falha caía depois do fim do arquivo — de vez em quando no
 * instante em que o vitest fechava o canal do worker, reprovando a suíte
 * inteira com `EnvironmentTeardownError` e nenhum teste vermelho.
 *
 * O relógio destes casos é UM tique de macrotarefa (`setTimeout(0)`): é menos
 * do que qualquer resolução de nome leva, e é o que o próprio setup espera
 * entre um teste e outro. Se algo voltar a depender da rede, a promessa não
 * assenta nesse tique e o caso reprova com o motivo — sem precisar reproduzir a
 * corrida.
 */
const PLACEHOLDER = "https://test-placeholder.invalid";
const umTique = () => new Promise((resolver) => setTimeout(resolver, 0));

describe("o placeholder do Supabase nos testes unitários", () => {
  it("recusa sem perguntar ao DNS: a promessa assenta antes do próximo tique", async () => {
    let desfecho: unknown = "ainda em voo — o fetch ao placeholder foi à rede";
    fetch(`${PLACEHOLDER}/rest/v1/api_audit_log`).then(
      () => (desfecho = "respondeu"),
      (erro: unknown) => (desfecho = erro),
    );
    await umTique();

    expect(desfecho).toBeInstanceOf(TypeError);
  });

  it("outro host continua indo ao fetch do ambiente — a recusa é só do placeholder", async () => {
    // `data:` não sai da máquina: prova que o desvio não engole o fetch inteiro.
    const resposta = await fetch("data:text/plain,ok");
    expect(await resposta.text()).toBe("ok");
  });

  // Só vale onde o placeholder está em uso — o CI, e quem roda sem `.env`.
  it.skipIf(process.env.NEXT_PUBLIC_SUPABASE_URL !== PLACEHOLDER)(
    "o audit solto de um handler relata a falha antes de o teste acabar",
    async () => {
      const erro = vi.spyOn(console, "error").mockImplementation(() => {});
      const { audit } = await import("@/lib/audit");

      void audit({ action: "agenda.appointment_updated", organizationId: "aaaaaaaa-1111-4000-8000-00000000000a" });
      await umTique();

      expect(erro).toHaveBeenCalledWith(
        "[audit] insert error",
        expect.stringContaining("fetch failed"),
        { action: "agenda.appointment_updated" },
      );
      erro.mockRestore();
    },
  );
});
