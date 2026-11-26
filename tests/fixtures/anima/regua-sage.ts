/**
 * Fork Ânima — a régua da paleta Sage do upstream, congelada para os testes de CALIBRAÇÃO.
 *
 * Os testes `branding-{contraste,rampa,pares-pintados,tema-escuro}.test.ts` calibram o ALGORITMO
 * de marca do upstream (constantes `ESCADA_L`/`CURVA_C`, caminhada de contraste, reconciliação)
 * contra a paleta da qual ele foi medido: a Sage. No fork o `globals.css` veste o DS Ânima, então
 * esses testes leem `globals-sage.css` (cópia do `app/globals.css` do upstream) em vez do arquivo
 * do produto. A régua é EXTRAÍDA dele, não copiada.
 *
 * A paleta Ânima tem seus próprios pisos vigiados em `tests/unit/anima-paleta-contraste.test.ts`.
 *
 * No sync: `git show vX.Y.Z:app/globals.css > tests/fixtures/anima/globals-sage.css`.
 */
import fs from "node:fs";
import path from "node:path";

import { extrairRegua } from "@/lib/branding/contraste";

export const CSS_SAGE = fs.readFileSync(
  path.join(process.cwd(), "tests/fixtures/anima/globals-sage.css"),
  "utf8",
);

export const REGUA_SAGE = extrairRegua(CSS_SAGE);
