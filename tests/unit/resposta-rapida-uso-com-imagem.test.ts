/**
 * O PAYLOAD DE USO DA RESPOSTA RÁPIDA (#2526) — texto e mídia juntos, ou só texto.
 *
 * Quando o operador escolhe uma resposta rápida no compositor, o que sai da
 * escolha é um payload único: o texto interpolado e as imagens que o próprio
 * operador carregou no template. É esse payload que decide o comportamento das
 * DUAS superfícies que importam:
 *
 *   1. COM O TEMPLATE TEM IMAGEM — o texto sai junto com a mídia, e vira a
 *      legenda da primeira imagem (o mesmo contrato do envio de mídia que já
 *      existe). Sem `midias` no payload, o compositor mandaria só o texto e a
 *      imagem ficaria para trás — o defeito inteiro da issue.
 *   2. SÓ TEXTO — continua só com texto, com `midias` vazio. É o caso que
 *      segura a regressão: 99% dos templates são texto puro e nenhum deles pode
 *      passar a exigir download, preview ou upload por causa desta feature.
 *
 * O teste não toca bucket nenhum: `midias` é a DESCRIÇÃO gravada na linha
 * (`storage_path` + mime + tamanho), que é o que a rota de leitura devolve e o
 * que o compositor usa para baixar os bytes. Baixar, subir e enviar é assunto
 * dos testes de mídia que já existem (`composer-note-mode`).
 */
import { describe, expect, it } from "vitest";

import { payloadDeUso } from "@/lib/inbox/template-vars";
import type { MidiaDeTemplate } from "@/lib/templates/midias";

const MIDIA: MidiaDeTemplate = {
  storage_path: "org-1/templates/tpl-1/9b1f0000-0000-4000-8000-0000000000aa.jpg",
  media_mime: "image/jpeg",
  media_size_bytes: 48213,
};

describe("payload de uso da resposta rápida", () => {
  it("⭐ template COM imagem: devolve o texto interpolado E as mídias", () => {
    const payload = payloadDeUso(
      { id: "tpl-1", body: "Olá {{primeiro_nome}}, veja o modelo.", midias: [MIDIA] },
      { name: "Ana Souza" },
    );

    expect(payload.texto).toBe("Olá Ana, veja o modelo.");
    expect(payload.midias).toHaveLength(1);
    expect(payload.midias[0]).toEqual(MIDIA);
  });

  it("template SÓ de texto: continua devolvendo só texto (midias vazio)", () => {
    const payload = payloadDeUso(
      { id: "tpl-2", body: "Oi {{nome}}, tudo bem?", midias: [] },
      { name: "Ana Souza" },
    );

    expect(payload.texto).toBe("Oi Ana Souza, tudo bem?");
    expect(payload.midias).toEqual([]);
  });
});
