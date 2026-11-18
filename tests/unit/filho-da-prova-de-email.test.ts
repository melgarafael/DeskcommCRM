import { expect, it } from "vitest";

import {
  encerrarFilhosDaProvaDeEmail,
  executarFilhoDaProvaDeEmail,
} from "../e2e/helpers/filho-da-prova-de-email";

it("devolve somente o recibo depois de fechar o filho próprio", async () => {
  const receipt = await executarFilhoDaProvaDeEmail(
    ["--eval", 'process.stdout.write(JSON.stringify({ok:true})+"\\n")'],
    {},
  );
  expect(receipt.result).toEqual({ ok: true });
  expect(receipt.closed_before_cleanup).toBe(true);
  expect(() => process.kill(receipt.pid, 0)).toThrow();
});

it("prazo mata e aguarda o filho sem vazar stderr/erro bruto antes do cleanup", async () => {
  let failure: Error & { pid?: number; closed_before_cleanup?: boolean } = new Error("sem falha");
  try {
    await executarFilhoDaProvaDeEmail(
      ["--eval", 'process.stderr.write("re_fixture_segredo_no_stderr");setInterval(()=>{},1000)'],
      {},
      100,
    );
  } catch (error) {
    failure = error as typeof failure;
  }
  expect(failure.message).toBe("O filho próprio da prova de e-mail falhou e já foi encerrado.");
  expect(JSON.stringify(failure).includes("re_fixture_segredo_no_stderr")).toBe(false);
  expect(failure.closed_before_cleanup).toBe(true);
  expect(failure.pid).toBeGreaterThan(0);
  expect(() => process.kill(failure.pid!, 0)).toThrow();
});

it("teardown do caso encerra o filho em voo e aguarda seu fechamento", async () => {
  const result = executarFilhoDaProvaDeEmail(["--eval", "setInterval(()=>{},1000)"], {}).catch(
    (error) => error as Error & { pid: number },
  );
  await encerrarFilhosDaProvaDeEmail();
  const failure = await result;
  expect(failure).toBeInstanceOf(Error);
  expect(() => process.kill((failure as Error & { pid: number }).pid, 0)).toThrow();
});
