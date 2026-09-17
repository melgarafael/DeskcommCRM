/**
 * Prova de ponta a ponta da Task 2: o `components[]` que `buildComponents` monta é
 * ACEITO pela Graph API real, e o que ele se recusa a montar é justamente o que a
 * Meta reprova com 132000.
 *
 *   pnpm exec tsx --env-file=.env.local scripts/spike-send-template.ts
 *
 * São DOIS envios, e só dois — cada um é uma mensagem real no celular de uma pessoa:
 *   1. contrato derivado do template VIVO + 3 valores → `buildComponents` → espera `wamid.…`
 *   2. o MESMO payload com o 3º parâmetro removido à mão (o payload que sai de quem
 *      redigita a contagem) → espera 132000.
 *
 * O passo 2 remove o parâmetro DEPOIS de `buildComponents` de propósito: o montador
 * se recusa a produzir payload incompleto, então a única forma de reproduzir o erro
 * é contornando-o — que é exatamente a demonstração desejada.
 */
import { graphVersion } from "@/lib/graph-version";
import { buildComponents, missingSlots } from "@/lib/channels/meta/build-components";
import { deriveTemplateContract, describeAddress } from "@/lib/channels/meta/template-contract";

const TEMPLATE = "jaspers_market_order_confirmation_v1";
const TO = process.env.META_TEST_RECIPIENT ?? "5531998966398";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`env ausente: ${name}`);
  return v;
}

const VERSION = graphVersion();
const BASE = `https://graph.facebook.com/${VERSION}`;
const TOKEN = env("META_SYSTEM_USER_TOKEN");

async function graph(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${BASE}/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  });
  return res.json();
}

async function main(): Promise<void> {
  // 1. O template VIVO, não a fixture — a prova é contra o que a Meta hospeda agora.
  const lista = (await graph(
    `${env("META_WABA_ID")}/message_templates?limit=50`,
  )) as { data?: { name: string; language: string; parameter_format?: string }[] };
  const raw = lista.data?.find((t) => t.name === TEMPLATE);
  if (!raw) throw new Error(`template ${TEMPLATE} não está na WABA`);

  const contract = deriveTemplateContract(raw as Parameters<typeof deriveTemplateContract>[0]);
  console.info(`\n━━ contrato derivado de ${contract.name} (${contract.language})`);
  for (const s of contract.slots) {
    console.info(`   ${describeAddress(s.address).padEnd(12)} {{${s.key}}}  ${s.expects}`);
  }

  const values = { "1": "Rafael", "2": "DESK-001", "3": "30/07" };
  console.info(`   missingSlots com os 3 valores: ${missingSlots(contract, values).length}`);

  const components = buildComponents(contract, values);
  console.info(`\n   components[] montado:\n${JSON.stringify(components, null, 2)}`);

  const envelope = {
    messaging_product: "whatsapp",
    to: TO,
    type: "template",
    template: { name: contract.name, language: { code: contract.language }, components },
  };
  const phone = env("META_PHONE_NUMBER_ID");

  // ── ENVIO 1 ──────────────────────────────────────────────────────────────────
  console.info(`\n━━ ENVIO 1 — payload de buildComponents (3 de 3 parâmetros)`);
  const ok = await graph(`${phone}/messages`, {
    method: "POST",
    body: JSON.stringify(envelope),
  });
  console.info(JSON.stringify(ok, null, 2));

  // ── ENVIO 2 ──────────────────────────────────────────────────────────────────
  // O payload de quem redigita a contagem: mesmo template, um parâmetro a menos.
  const capenga = structuredClone(envelope);
  const body = capenga.template.components.find((c) => c.type === "body");
  if (!body || !("parameters" in body)) throw new Error("componente body sumiu");
  const removido = body.parameters.pop();
  console.info(
    `\n━━ ENVIO 2 — o MESMO payload com 1 parâmetro removido à mão: ${JSON.stringify(removido)}`,
  );
  console.info(
    `   (buildComponents se recusaria: missingSlots aponta ` +
      `${missingSlots(contract, { "1": values["1"], "2": values["2"] }).map((s) => `{{${s.key}}}`).join(", ")})`,
  );
  const erro = await graph(`${phone}/messages`, {
    method: "POST",
    body: JSON.stringify(capenga),
  });
  console.info(JSON.stringify(erro, null, 2));
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
