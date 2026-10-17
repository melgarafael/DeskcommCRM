// C1e — o `standalone` do app leva o mysql2 completo?
//
// O `.next/standalone` copia SÓ o que o rastreamento de arquivos detecta, e neste
// repositório ele já deixou `pdfjs-dist` e `@swc/helpers` pelo caminho (ver
// next.config.ts). Este script roda DEPOIS de `pnpm build` e resolve o `mysql2`
// a partir da pasta do standalone, como o container da VPS faria. Se não resolver,
// o MySQL só quebraria em produção, ao abrir a primeira conexão.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const raiz = join(process.cwd(), ".next", "standalone");
if (!existsSync(raiz)) {
  console.error("FALHOU: não existe .next/standalone — rode `pnpm build` antes.");
  process.exit(2);
}

const requerer = createRequire(join(raiz, "server.js"));
try {
  const modulo = requerer("mysql2/promise");
  console.log(`OK: mysql2/promise resolve a partir do standalone (createPool: ${typeof modulo.createPool}).`);
} catch (erro) {
  console.error(
    `FALHOU: mysql2/promise NÃO resolve a partir do standalone — ${erro.code ?? "erro"}: ${String(erro.message).split("\n", 1)[0]}`,
  );
  process.exit(1);
}
