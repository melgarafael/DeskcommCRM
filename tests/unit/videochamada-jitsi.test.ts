// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  novaSala,
  resolveServidorDeVideo,
  servidorDeVideo,
  urlDaSala,
} from "@/lib/video/jitsi";

/**
 * A VIDEOCHAMADA NASCE DESESLIGADA E NUNCA ERRA POR ISSO (#2440), e a sala
 * não é derivada de mais nada (#2441).
 *
 * Três coisas aqui são contrato, não detalhe:
 *
 *  1. Vazio (o caso de TODA instalação que não configurou `JITSI_SERVER_URL`)
 *     devolve `null`, e é esse `null` que esconde o botão. Padrão de
 *     `WACALLS_API_BASE_URL`: esconde, nunca erro.
 *  2. Barra no fim é aparada — `.env` escrito à mão traz `https://meet.jit.si/`
 *     e a sala viraria `...si//sala-...`, que é uma sala DIFERENTE no Jitsi
 *     (a parte depois do host muda o nome). Medido na escrita do PR, não
 *     deduzido.
 *  3. Fora de `http(s)` vira `null`: desde o review do #2441 a URL vira
 *     `href` de um `<a>`, e um `javascript:` no `.env` seria código rodando no
 *     clique do operador. O Zod de `lib/env.ts` já recusa e desliga a feature
 *     (a `catch()` manda o aviso pro log); esta triagem é quem protege o lado
 *     do navegador, que lê o payload injetado e não passa pelo Zod de novo.
 */
describe("servidor de videochamada (Jitsi)", () => {
  it("vazio, só espaço ou ausente = a instalação não oferece videochamada", () => {
    expect(resolveServidorDeVideo(undefined)).toBeNull();
    expect(resolveServidorDeVideo(null)).toBeNull();
    expect(resolveServidorDeVideo("")).toBeNull();
    expect(resolveServidorDeVideo("   ")).toBeNull();
    expect(resolveServidorDeVideo("   /  ")).toBeNull();
  });

  it("apara espaço e barra(s) do fim — uma sala só, não duas", () => {
    expect(resolveServidorDeVideo("  https://meet.jit.si ")).toBe(
      "https://meet.jit.si",
    );
    expect(resolveServidorDeVideo("https://meet.jit.si///")).toBe(
      "https://meet.jit.si",
    );
    expect(resolveServidorDeVideo("https://video.empresa.com.br/")).toBe(
      "https://video.empresa.com.br",
    );
  });

  it("mantém caminho interno (instalação com Jitsi atrás de subdiretório)", () => {
    expect(resolveServidorDeVideo("https://empresa.com/jitsi")).toBe(
      "https://empresa.com/jitsi",
    );
  });

  it("fora de http(s) vira null — a URL vira href, não pode virar código", () => {
    expect(resolveServidorDeVideo("javascript:alert(1)")).toBeNull();
    expect(resolveServidorDeVideo("data:text/html,<script>x</script>")).toBeNull();
    expect(resolveServidorDeVideo("file:///etc/passwd")).toBeNull();
    expect(resolveServidorDeVideo("meet.jit.si")).toBeNull(); // sem esquema
    // E o resultado inseguro NÃO escapa nem mesmo concatenado depois:
    expect(urlDaSala(resolveServidorDeVideo("javascript:alert(1)"), "sala-1")).toBeNull();
  });

  it("no servidor lê process.env, sem janela", () => {
    // Ambiente de teste não tem `window`; é o ramo do servidor que roda.
    const antes = process.env.JITSI_SERVER_URL;
    process.env.JITSI_SERVER_URL = "https://meet.jit.si/";
    expect(servidorDeVideo()).toBe("https://meet.jit.si");
    process.env.JITSI_SERVER_URL = "";
    expect(servidorDeVideo()).toBeNull();
    if (antes === undefined) delete process.env.JITSI_SERVER_URL;
    else process.env.JITSI_SERVER_URL = antes;
  });
});

/**
 * A SALA É ALEATÓRIA E A CADA CHAMADA (#2441).
 *
 * O formato anterior era `deskcomm-<conversationId>`, e o review do #2441
 * derrubou as duas metades dele:
 *
 *  - **O UUID da conversa saía para fora.** O link vai para o cliente final e
 *    o id interno da conversa não é dele.
 *  - **A sala era fixa.** O link de UMA consulta entraria na seguinte, enquanto
 *    a conversa existir — e o segundo clique no botão reenviava a MESMA sala
 *    já aberta.
 *
 * O prefixo também mudou, de `deskcomm-` para `sala-`: este link cai na tela
 * de quem revende a instalação, e a sala não é lugar de marca.
 */
describe("a sala é aleatória e por chamada", () => {
  it("prefixa com 'sala-' e não com o nome do produto", () => {
    const sala = novaSala();
    expect(sala.startsWith("sala-")).toBe(true);
    // Regra de marca: nada do nome do produto na sala (#2441 — entrou na
    // conversa do cliente final). Se isto falhar, é o prefixo que mudou.
    expect(sala.toLowerCase()).not.toContain("deskcomm");
    expect(sala.toLowerCase()).not.toContain("upsay");
    expect(sala.toLowerCase()).not.toContain("webtecnica");
  });

  it("duas chamadas nunca caem na mesma sala", () => {
    // É o que protege a conversa seguinte da sala da anterior.
    expect(novaSala()).not.toBe(novaSala());
    const salas = new Set(Array.from({ length: 50 }, () => novaSala()));
    expect(salas.size).toBe(50);
  });

  it("a sala é um slug que a URL aceita (sem espaço, com hífen)", () => {
    const sala = novaSala();
    expect(sala).toMatch(/^sala-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(sala).not.toMatch(/\s/);
  });

  it("URL completa só quando há servidor; sem servidor, nada de sala órfã", () => {
    expect(urlDaSala("https://meet.jit.si", "sala-x")).toBe(
      "https://meet.jit.si/sala-x",
    );
    expect(urlDaSala(null, "sala-x")).toBeNull();
    expect(urlDaSala(resolveServidorDeVideo(""), "sala-x")).toBeNull();
  });
});

describe("a sala nasce também fora de contexto seguro (self-host em http://IP)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sem crypto.randomUUID (o navegador em http://IP) a sala ainda nasce, aleatória", () => {
    // Exatamente o navegador fora de https/localhost: `getRandomValues` existe,
    // `randomUUID` não. Com a chamada crua, o clique em "Vídeo" lançava TypeError.
    vi.stubGlobal("crypto", { getRandomValues: crypto.getRandomValues.bind(crypto) });
    const salas = Array.from({ length: 50 }, () => novaSala());
    for (const sala of salas) {
      expect(sala).toMatch(
        /^sala-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
    expect(new Set(salas).size).toBe(50);
  });
});
