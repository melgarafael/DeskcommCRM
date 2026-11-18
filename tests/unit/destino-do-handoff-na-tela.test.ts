import { describe, expect, it } from "vitest";

import { resolverDestinoDoAtribuir } from "@/lib/automation/destino-do-atribuir";
import {
  ARVORE_DO_DESTINO_DO_HANDOFF,
  CHAVE_DO_DESTINO_DO_HANDOFF,
  configDoDestinoDoHandoff,
} from "@/lib/escalacao/destino-do-handoff";
import { atendimentoConfigPatchSchema } from "@/lib/schemas";
import {
  destinoDoHandoffDaOrg,
  mesclarSettingsDeAtendimento,
  type DestinoDoHandoffConfig,
} from "@/lib/schemas/routing";

/**
 * A CONFIGURAÇÃO DO HANDOFF TEM COMO SER LIGADA — pela rota, e no lugar que o
 * handoff lê (#3804 item 3).
 *
 * O defeito medido no PR #3822/`#3969`: a decisão de entregar a conversa ao
 * responsável do negócio existia inteira no código, e NENHUMA rota nem tela
 * gravava `settings.atendimento.destino_do_handoff`. Num self-host isso equivale
 * a não existir (o mesmo que a #144 registrou sobre `visibility_mode`).
 *
 * O que se prova aqui não é "o schema aceita um objeto": é que o que a rota
 * GRAVA é o que o handoff LÊ e o que o resolvedor do #3822 RESOLVE. Se alguém
 * mudar a árvore, a chave ou o vocabulário em um dos lados, este teste fica
 * vermelho — que é o único jeito de o jsonb não virar duas verdades.
 */

const RESPONSAVEL = "11111111-1111-4111-8111-111111111111";
const CARTEIRA = "22222222-2222-4222-8222-222222222222";

const LIGADO: DestinoDoHandoffConfig = {
  modo: "destino",
  destinos: ["responsavel_do_negocio", "dono_da_carteira"],
  fallback: { modo: "rodizio" },
};

/** O corpo do PATCH como a tela manda: o formulário inteiro, mais a chave. */
function corpoCom(destino: DestinoDoHandoffConfig | null) {
  return atendimentoConfigPatchSchema.parse({
    mode: "round_robin",
    destino_do_handoff: destino,
  });
}

describe("destino do handoff — o que a rota grava é o que o handoff lê", () => {
  it("grava em `settings.atendimento.destino_do_handoff`, a MESMA árvore do leitor", () => {
    const { settings } = mesclarSettingsDeAtendimento({}, corpoCom(LIGADO));

    const arvore = settings[ARVORE_DO_DESTINO_DO_HANDOFF] as Record<string, unknown>;
    expect(arvore).toBeDefined();
    expect(arvore[CHAVE_DO_DESTINO_DO_HANDOFF]).toEqual(LIGADO);
    // E o leitor do handoff — o que roda na passagem — enxerga o mesmo objeto.
    expect(configDoDestinoDoHandoff(settings)).toEqual(LIGADO);
  });

  it("a cadeia chega INTEIRA ao resolvedor do #3822, sem segunda função", () => {
    const { settings } = mesclarSettingsDeAtendimento({}, corpoCom(LIGADO));
    const config = configDoDestinoDoHandoff(settings);

    const negocio = { owner_user_id: RESPONSAVEL, owner_kind: "user" };
    const contato = { carteira_user_id: CARTEIRA };

    expect(resolverDestinoDoAtribuir(negocio, contato, config)).toEqual({
      user_id: RESPONSAVEL,
      motivo: "responsavel_do_negocio",
      descartes: [],
    });
    // Negócio sem dono → a carteira, que é o outro elo da MESMA cadeia.
    expect(resolverDestinoDoAtribuir({ owner_user_id: null }, contato, config)).toEqual({
      user_id: CARTEIRA,
      motivo: "dono_da_carteira",
      descartes: [{ elo: "responsavel_do_negocio", motivo: "ausente" }],
    });
  });

  it("negócio sem dono e contato sem carteira: o fallback decidido na tela", () => {
    const { settings } = mesclarSettingsDeAtendimento({}, corpoCom(LIGADO));
    const config = configDoDestinoDoHandoff(settings);

    expect(resolverDestinoDoAtribuir(null, null, config)).toEqual({
      user_id: null,
      motivo: "fallback_rodizio",
      descartes: [
        { elo: "responsavel_do_negocio", motivo: "ausente" },
        { elo: "dono_da_carteira", motivo: "ausente" },
      ],
    });
  });

  it("fallback `null` = fila da Central, e é comportamento DECLARADO", () => {
    const { settings } = mesclarSettingsDeAtendimento(
      {},
      corpoCom({ ...LIGADO, fallback: null }),
    );
    const config = configDoDestinoDoHandoff(settings);

    // `sem_destino`: quem chama mantém o caminho de hoje (a Central recebe).
    // Nunca uma pessoa escolhida no escuro.
    expect(resolverDestinoDoAtribuir(null, null, config)).toEqual({
      user_id: null,
      motivo: "sem_destino",
      descartes: [
        { elo: "responsavel_do_negocio", motivo: "ausente" },
        { elo: "dono_da_carteira", motivo: "ausente" },
      ],
    });
  });
});

describe("destino do handoff — desligar não é omitir", () => {
  it("omitido PRESERVA o que já valia (cliente antigo não desliga por omissão)", () => {
    const atual = { atendimento: { destino_do_handoff: LIGADO } };
    const { settings, destino_do_handoff } = mesclarSettingsDeAtendimento(
      atual,
      atendimentoConfigPatchSchema.parse({ mode: "load" }),
    );

    expect(configDoDestinoDoHandoff(settings)).toEqual(LIGADO);
    expect(destino_do_handoff).toEqual(LIGADO);
  });

  it("`null` APAGA a chave e não escreve objeto torto", () => {
    const atual = {
      atendimento: { destino_do_handoff: LIGADO, outra_decisao: { ligada: true } },
    };
    const { settings } = mesclarSettingsDeAtendimento(atual, corpoCom(null));

    const arvore = settings[ARVORE_DO_DESTINO_DO_HANDOFF] as Record<string, unknown>;
    expect(arvore).not.toHaveProperty(CHAVE_DO_DESTINO_DO_HANDOFF);
    // As outras folhas da árvore de atendimento continuam onde estavam.
    expect(arvore.outra_decisao).toEqual({ ligada: true });
    expect(configDoDestinoDoHandoff(settings)).toBeNull();
  });

  it("não toca nas outras chaves de `settings` nem no roteamento", () => {
    const atual = {
      ai: { provider: "openai" },
      routing: { mode: "manual", max_retries: 3 },
    };
    const { settings, routing } = mesclarSettingsDeAtendimento(atual, corpoCom(LIGADO));

    expect(settings.ai).toEqual({ provider: "openai" });
    expect(routing.mode).toBe("round_robin");
    // O corpo do PATCH passa pelo schema (com defaults), como o da tela: o que
    // se prova aqui é que a árvore `atendimento` não é o lugar do roteamento.
    expect(settings).toHaveProperty("routing");
    expect(settings[ARVORE_DO_DESTINO_DO_HANDOFF]).toBeDefined();
  });
});

describe("destino do handoff — a tela não grava o que o handoff não entende", () => {
  it.each([
    ["lista vazia", { ...LIGADO, destinos: [] }],
    ["destino repetido", { ...LIGADO, destinos: ["dono_da_carteira", "dono_da_carteira"] }],
    ["destino desconhecido", { ...LIGADO, destinos: ["responsavel_da_conversa"] }],
    ["modo diferente", { ...LIGADO, modo: "fixo" }],
    ["fallback de pessoa sem id válido", { ...LIGADO, fallback: { modo: "fixo", user_id: "x" } }],
  ])("recusa %s na borda", (_nome, corpo) => {
    const lido = atendimentoConfigPatchSchema.safeParse({ destino_do_handoff: corpo });
    expect(lido.success).toBe(false);
  });

  it("valor torto de outra versão vira `null` (handoff de hoje), sem estourar a tela", () => {
    expect(destinoDoHandoffDaOrg({ atendimento: { destino_do_handoff: { modo: "lixo" } } })).toBeNull();
    expect(destinoDoHandoffDaOrg({ atendimento: { destino_do_handoff: LIGADO } })).toEqual(LIGADO);
    expect(destinoDoHandoffDaOrg(null)).toBeNull();
    // E a régua da tela e a do handoff concordam sobre o mesmo jsonb.
    expect(configDoDestinoDoHandoff({ atendimento: { destino_do_handoff: { modo: "lixo" } } })).toBeNull();
  });
});
