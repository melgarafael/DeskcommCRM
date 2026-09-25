/**
 * A CONFIG DE ATENDIMENTO tem porta, e a porta não desliga a restrição sozinha
 * (issue #144).
 *
 * ## O que estava quebrado
 *
 * `settings.visibility_mode` — o que faz um atendente ver só os leads dele — era
 * LIDO em `app/app/layout.tsx` e escrito por NINGUÉM. A RLS existia
 * (`fn_can_view_lead`), o schema existia, a doutrina existia, e o único jeito de
 * ligar era `UPDATE` à mão no Postgres. Num produto self-host, feature sem
 * caminho no produto é feature que não existe.
 *
 * ## O que se guarda aqui
 *
 * A regra do PATCH, que é onde mora o risco de a restrição cair por acidente:
 * um cliente antigo, que só conhece o roteamento, manda um corpo SEM
 * `visibility_mode`. Se o handler tratasse ausência como "volte ao default", a
 * org perderia a restrição sem ninguém pedir — e ninguém notaria, porque o
 * sintoma é dado a MAIS na tela, não erro.
 */
import { describe, expect, it } from "vitest";

import {
  VISIBILITY_MODES,
  atendimentoConfigPatchSchema,
  mesclarSettingsDeAtendimento,
  routingConfigSchema,
} from "@/lib/schemas/routing";
import { DEFAULT_VISIBILITY_MODE, type VisibilityMode } from "@/lib/auth/types";

/**
 * A regra de merge do handler, extraída para poder ser exercitada sem HTTP.
 * Espelha `app/api/v1/settings/routing/route.ts` — e o caso de vacuidade abaixo
 * cobra que ela não vire uma cópia que passou a discordar do original.
 */
function proximoSettings(
  atual: Record<string, unknown>,
  corpo: unknown,
): Record<string, unknown> {
  // A MESMA função da rota (antes este helper era uma cópia dela, e cópia
  // diverge sem avisar).
  return mesclarSettingsDeAtendimento(atual, atendimentoConfigPatchSchema.parse(corpo)).settings;
}

describe("config de atendimento — routing + visibilidade na mesma porta", () => {
  it("os três modos de visibilidade do schema são os mesmos do tipo de auth", () => {
    // As duas listas moram em arquivos diferentes por motivo real (uma valida
    // input externo, a outra tipa a sessão). Divergir significaria a tela
    // oferecer um modo que a RLS não entende — e a RLS cai no `else`, que é
    // "não vê nada".
    const doTipo: VisibilityMode[] = ["all", "own_and_unassigned", "own"];
    expect([...VISIBILITY_MODES]).toEqual(doTipo);
    expect(VISIBILITY_MODES).toContain(DEFAULT_VISIBILITY_MODE);
  });

  it("corpo SEM visibility_mode preserva a que já valia", () => {
    const atual = { visibility_mode: "own", routing: { mode: "manual" }, outra_chave: 1 };
    const proximo = proximoSettings(atual, { mode: "round_robin", max_retries: 5, backoff_seconds: 60 });

    expect(
      proximo.visibility_mode,
      "cliente que só conhece roteamento não pode desligar a restrição sem pedir",
    ).toBe("own");
    expect((proximo.routing as { mode: string }).mode).toBe("round_robin");
    // Merge não-destrutivo: as demais chaves do jsonb de settings sobrevivem.
    expect(proximo.outra_chave).toBe(1);
  });

  it("corpo COM visibility_mode grava o valor pedido", () => {
    const proximo = proximoSettings(
      { visibility_mode: "all" },
      { mode: "round_robin", max_retries: 5, backoff_seconds: 60, visibility_mode: "own" },
    );
    expect(proximo.visibility_mode).toBe("own");
  });

  it("modo de visibilidade inválido é recusado, não normalizado", () => {
    // Aceitar e cair num default seria o pior desfecho: a tela confirmaria o
    // salvamento e a org ficaria num modo que ninguém escolheu.
    expect(() =>
      atendimentoConfigPatchSchema.parse({
        mode: "manual",
        max_retries: 5,
        backoff_seconds: 60,
        visibility_mode: "somente_o_chefe",
      }),
    ).toThrow();
  });

  it("o schema de roteamento segue aceitando o corpo antigo (guarda de compatibilidade)", () => {
    // O contrato v1 já estava publicado. Se o corpo de antes deixasse de valer,
    // a mudança seria quebra de API disfarçada de feature nova.
    const antigo = { mode: "round_robin", max_retries: 3, backoff_seconds: 30 };
    // O corpo antigo não conhece o prazo de devolução nem "a conversa fica com
    // quem atendeu": no PATCH eles ficam OMITIDOS (e a mescla preserva o que
    // vale), no schema do jsonb eles têm o padrão (null e false).
    const {
      handoff_return_after_minutes: _padrao,
      conversation_stays_with_attendant: _fica,
      ...semPrazo
    } = routingConfigSchema.parse(antigo);
    expect(atendimentoConfigPatchSchema.parse(antigo)).toEqual(semPrazo);
  });

  it("corpo SEM handoff_return_after_minutes preserva o prazo que já valia", () => {
    const atual = { routing: { mode: "manual", handoff_return_after_minutes: 60 } };
    const proximo = proximoSettings(atual, { mode: "round_robin", max_retries: 5, backoff_seconds: 60 });
    expect(
      (proximo.routing as { handoff_return_after_minutes: number | null }).handoff_return_after_minutes,
      "cliente que só conhece roteamento não pode desligar a devolução automática por omissão",
    ).toBe(60);
  });

  it("handoff_return_after_minutes: null desliga; fora da faixa é recusado", () => {
    const atual = { routing: { mode: "manual", handoff_return_after_minutes: 60 } };
    const proximo = proximoSettings(atual, {
      mode: "manual",
      max_retries: 5,
      backoff_seconds: 60,
      handoff_return_after_minutes: null,
    });
    expect((proximo.routing as { handoff_return_after_minutes: unknown }).handoff_return_after_minutes).toBeNull();
    expect(() =>
      atendimentoConfigPatchSchema.parse({ mode: "manual", max_retries: 5, backoff_seconds: 60, handoff_return_after_minutes: 2 }),
    ).toThrow();
    expect(() =>
      atendimentoConfigPatchSchema.parse({ mode: "manual", max_retries: 5, backoff_seconds: 60, handoff_return_after_minutes: 1441 }),
    ).toThrow();
  });
});
