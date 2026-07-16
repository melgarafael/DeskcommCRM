// update-feature.ts — a ÚNICA porta de escrita do loop em plan/features.json.
//
// Uso: node loop/update-feature.ts --id G1-01 --passes true --verification '<json>'
//
// Altera SOMENTE os campos "passes" e "verification" da feature indicada.
// Qualquer outra mutação do plano é ato humano (DESKCOMM_GOV_PLAN_EDIT=1) —
// e o pre-commit (loop/hooks/validate-features.sh) revalida o diff de qualquer forma.
//
// Notas de runtime (decisão documentada):
// - Corpo em JavaScript puro, sintaxe CommonJS, num arquivo .ts — roda direto em
//   Node >= 22.18 (type-stripping default; CJS porque o package.json do repo não
//   declara "type"). Em Node 22.6-22.17: node --experimental-strip-types.
//   Escolhido assim para manter o comando canônico `node loop/update-feature.ts`
//   (documentado no plano) funcionando sem transpiler, com robustez de JS puro.
// - Escrita com JSON.stringify(plan, null, 2): formatação canônica estável. A
//   PRIMEIRA execução normaliza arrays compactados à mão (ex.: depends_on em uma
//   linha) — reformat único, semanticamente idêntico (o pre-commit compara via
//   jq -S); todas as execuções seguintes produzem diff mínimo.

const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const FEATURES_PATH = join(__dirname, "..", "plan", "features.json");

function fail(msg) {
  console.error(`update-feature: ${msg}`);
  console.error("Uso: node loop/update-feature.ts --id <ID> [--passes true|false] [--verification '<json>']");
  process.exit(1);
}

// --- parse da CLI (só as 3 flags; qualquer outra coisa é recusada) ---
const args = process.argv.slice(2);
const opts = {};
for (let i = 0; i < args.length; i += 2) {
  const flag = args[i];
  const value = args[i + 1];
  if (!["--id", "--passes", "--verification"].includes(flag)) {
    fail(`flag desconhecida: ${flag} — este script só altera passes/verification.`);
  }
  if (value === undefined) fail(`flag ${flag} sem valor.`);
  if (flag in opts) fail(`flag ${flag} repetida.`);
  opts[flag] = value;
}

if (!opts["--id"]) fail("--id é obrigatório.");
if (!("--passes" in opts) && !("--verification" in opts)) {
  fail("nada a fazer: informe --passes e/ou --verification.");
}

let passes;
if ("--passes" in opts) {
  if (opts["--passes"] !== "true" && opts["--passes"] !== "false") {
    fail(`--passes deve ser 'true' ou 'false' (recebi: ${opts["--passes"]}).`);
  }
  passes = opts["--passes"] === "true";
}

let verification;
if ("--verification" in opts) {
  try {
    verification = JSON.parse(opts["--verification"]);
  } catch (err) {
    fail(`--verification não é JSON válido: ${err.message}`);
  }
}

// --- leitura, mutação cirúrgica, escrita com formatação estável ---
let plan;
try {
  plan = JSON.parse(readFileSync(FEATURES_PATH, "utf8"));
} catch (err) {
  fail(`não consegui ler/parsear ${FEATURES_PATH}: ${err.message}`);
}

if (!Array.isArray(plan.features)) fail("plan/features.json sem array .features.");

const feature = plan.features.find((f) => f.id === opts["--id"]);
if (!feature) {
  const ids = plan.features.map((f) => f.id).join(", ");
  fail(`feature '${opts["--id"]}' não existe. Ids válidos: ${ids}`);
}

if (passes !== undefined) feature.passes = passes;
if (verification !== undefined) feature.verification = verification;

writeFileSync(FEATURES_PATH, JSON.stringify(plan, null, 2) + "\n");
console.log(
  `ok: ${feature.id} → passes=${feature.passes} verification=${JSON.stringify(feature.verification)}`
);
