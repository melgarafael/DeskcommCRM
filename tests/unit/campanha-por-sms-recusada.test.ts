import { describe, expect, it } from "vitest";

import { decidirConteudo, lerModoDoCanal } from "@/lib/campanhas/conteudo-do-canal";
import { CHANNEL_PROVIDER_TWILIO, CHANNEL_PROVIDER_WAHA, modoDeCampanhaDoCanal } from "@/lib/channels/capabilities";

/**
 * A campanha por SMS não entra na primeira fatia do canal (#4415): decisão do
 * dono no doc 366, como foi com o robô de mensagens. O SMS manda texto a
 * qualquer hora, e por isso a regra mora na lista de canais sem campanha, e não
 * numa capability falsa de janela, que mudaria o que a conversa pode fazer.
 *
 * O caminho medido é o das duas rotas de campanha (`POST /api/v1/campaigns` e
 * `PATCH /api/v1/campaigns/[id]`): `lerModoDoCanal` lê o canal da conexão
 * escolhida e `decidirConteudo` recusa com 409 e a frase que a tela mostra.
 */
const umaLinha = (provider: string) =>
  ({
    from: () => {
      const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { id: "sess-1", provider } }) };
      return q;
    },
  }) as never;

describe("campanha por uma conexão de SMS", () => {
  it("o canal não tem modo de campanha, e criar uma responde 409 dizendo que o canal não envia campanhas", async () => {
    expect(modoDeCampanhaDoCanal(CHANNEL_PROVIDER_TWILIO)).toBeNull();

    const lido = await lerModoDoCanal(umaLinha(CHANNEL_PROVIDER_TWILIO), "org-1", "sess-1");
    expect(lido).toMatchObject({ existe: true, modo: null });

    const decisao = await decidirConteudo(umaLinha(CHANNEL_PROVIDER_TWILIO), {
      organizationId: "org-1",
      channelSessionId: "sess-1",
      extras: [],
      modoDoCanal: lido.existe ? lido.modo : null,
      pedido: { message_body: "Promoção de inverno" },
    });
    expect(decisao).toEqual({
      ok: false,
      codigo: "campanha_canal_indisponivel",
      mensagem: "Este canal não envia campanhas.",
      status: 409,
    });
  });

  it("controle: a mesma leitura com o número por QR devolve texto livre", async () => {
    // Sem este controle, um dublê que sempre respondesse null passaria no caso acima.
    expect(await lerModoDoCanal(umaLinha(CHANNEL_PROVIDER_WAHA), "org-1", "sess-1")).toMatchObject({ modo: "text" });
  });
});
