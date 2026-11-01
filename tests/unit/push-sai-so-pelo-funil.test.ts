/**
 * TODO PUSH SAI PELO FUNIL de `lib/notifications/web_push.ts`.
 *
 * É lá que a opção da empresa sobre o que aparece com a tela bloqueada é
 * aplicada (`lib/notifications/tela-bloqueada.ts`). Um segundo caminho até o
 * serviço de push — outro import de `web-push`, outro `sendNotification(` —
 * entregaria o payload sem passar pela redação.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { arquivosDeCodigo, caminhoRelativo } from "./helpers/varrer-codigo";

const FUNIL = "lib/notifications/web_push.ts";
const arquivos = arquivosDeCodigo(["app", "lib", "workers", "hooks", "components", "scripts"]).map((a) => ({
  caminho: caminhoRelativo(a),
  texto: readFileSync(a, "utf8"),
}));

describe("o push sai só pelo funil", () => {
  it("a varredura enxergou o funil (controle positivo)", () => {
    expect(arquivos.length).toBeGreaterThan(100);
    expect(arquivos.map((a) => a.caminho)).toContain(FUNIL);
  });

  it("só o funil importa 'web-push'", () => {
    const importam = arquivos.filter((a) => /from\s+["']web-push["']|require\(\s*["']web-push["']\s*\)/.test(a.texto));
    expect(importam.map((a) => a.caminho)).toEqual([FUNIL]);
  });

  it("só o funil chama sendNotification(", () => {
    const chamam = arquivos.filter((a) => a.texto.includes("sendNotification("));
    expect(chamam.map((a) => a.caminho)).toEqual([FUNIL]);
  });

  it("o que vai ao serviço de push é a saída da redação, nunca o payload cru", () => {
    const funil = arquivos.find((a) => a.caminho === FUNIL)!.texto;
    expect(funil).toMatch(/JSON\.stringify\(\s*redigirParaATelaBloqueada\(/);
    expect(funil.match(/JSON\.stringify\(/g)).toHaveLength(1);
  });
});

describe("a bandeja local sai só pelo funil de entregarAviso", () => {
  const FUNIL_LOCAL = "lib/notifications/deliver.ts";
  // A confirmação de ligar/desligar os alertas tem texto fixo do próprio app.
  const TEXTO_FIXO = "hooks/notifications/useNotificationPermission.ts";

  it("só o funil local (e a confirmação de texto fixo) chama emitNotification(", () => {
    const chamam = arquivos.filter(
      (a) => a.caminho !== "lib/notifications/emit.ts" && !/\.test\.tsx?$/.test(a.caminho) && a.texto.includes("emitNotification("),
    );
    expect(chamam.map((a) => a.caminho).sort()).toEqual([FUNIL_LOCAL, TEXTO_FIXO].sort());
  });

  it("o funil local entrega à bandeja a saída da redação, sem atalho que a pule", () => {
    const funil = arquivos.find((a) => a.caminho === FUNIL_LOCAL)!.texto;
    expect(funil).toMatch(/const bandeja = redigirParaATelaBloqueada\(/);
    expect(funil.match(/emitNotification\(/g)).toHaveLength(1);
    expect(funil).toMatch(/title: traduzir\(bandeja\.title, idioma\)/);
    expect(funil).toMatch(/body: traduzir\(bandeja\.body, idioma\)/);
  });
});
