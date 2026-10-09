/**
 * Todo caminho que ARQUIVA `channel_sessions` fecha o aviso de pausa (issue #2389).
 *
 * O aviso `canal_pausado` só resolve quando alguém chama o fechador depois de
 * gravar `archived_at`. O PR original cobria as rotas de `channel-sessions`; a
 * desconexão em Redes Sociais arquivava o canal sem chamá-lo, e uma conta
 * pausada e depois desconectada deixava o aviso aberto para sempre (a lição do
 * #1023). Esta cerca acha os arquivamentos pelo código, não por lista: um
 * caminho novo que arquive canal sem fechar o aviso reprova aqui.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ARQUIVA = /archived_at:\s*(now|agora|new Date)/;
const DA_TABELA = /from\("channel_sessions"\)/;
const FECHA = /\b(sincronizarAvisoDePausa|fecharAvisoDePausaDoCanalArquivado)\(/;

const fontes = execFileSync("git", ["ls-files", "app", "lib", "workers"], { encoding: "utf8" })
  .split("\n")
  .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));

const arquivam = fontes.filter((f) => {
  const s = readFileSync(f, "utf8");
  return ARQUIVA.test(s) && DA_TABELA.test(s);
});

describe("arquivar canal fecha o aviso de pausa", () => {
  it("a sonda enxerga os arquivamentos conhecidos (controle positivo)", () => {
    expect(arquivam).toEqual(
      expect.arrayContaining([
        "app/api/v1/channel-sessions/[id]/route.ts",
        "lib/channels/social/store.ts",
      ]),
    );
  });

  it("todo arquivo que arquiva channel_sessions chama o fechador da pausa", () => {
    expect(arquivam.filter((f) => !FECHA.test(readFileSync(f, "utf8")))).toEqual([]);
  });
});
