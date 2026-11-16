#!/usr/bin/env node
/** Contratos adicionais de conta própria; os13smokes legados continuam byte a byte. */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const fixture = JSON.parse(
  readFileSync(new URL("../tests/fixtures/resend-da-organizacao.json", import.meta.url), "utf8"),
);
const base = process.argv[2] ?? "http://127.0.0.1:3997";
if (!["127.0.0.1", "localhost"].includes(new URL(base).hostname))
  throw new Error("O smoke exige receiver local.");
let checks = 0;
function check(name, ok) {
  if (!ok) {
    process.stdout.write(`FALHOU ${name}\n`);
    throw new Error("contrato");
  }
  checks++;
  process.stdout.write(`ok ${name}\n`);
}
async function request(route, key, body) {
  const response = await fetch(base + route, {
    method: body ? "POST" : "GET",
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(5_000),
  });
  return { status: response.status, body: await response.json() };
}
const hash = (v) => createHash("sha256").update(v).digest("hex");
try {
  const noKey = await request("/domains");
  check(
    "domínios sem chave recusados",
    noKey.status === 401 && noKey.body.name === "missing_api_key",
  );
  for (const account of [fixture.a, fixture.b]) {
    const list = await request("/domains", account.key);
    check(
      `domínio próprio ${account.id}`,
      list.status === 200 &&
        list.body.data.length === 1 &&
        list.body.data[0].name === account.domain &&
        list.body.data[0].status === "verified",
    );
    const detail = await request(`/domains/${account.id}`, account.key);
    check(
      `registros oficiais ${account.id}`,
      detail.status === 200 &&
        detail.body.capabilities.sending === "enabled" &&
        detail.body.records.some((r) => r.name === `outbound.${account.domain}`) &&
        detail.body.records.some((r) => r.type === "CNAME"),
    );
  }
  const permission = await request("/domains", fixture.errors.permission);
  check(
    "permissão distinguida",
    permission.status === 401 && permission.body.name === "restricted_api_key",
  );
  const pending = await request("/domains", fixture.errors.pending);
  check(
    "pendente não vira verificado",
    pending.status === 200 && pending.body.data[0].status === "pending",
  );
  const disabled = await request("/domains", fixture.errors.disabled);
  check(
    "envio desligado explícito",
    disabled.status === 200 && disabled.body.data[0].capabilities.sending === "disabled",
  );
  const unavailable = await request("/domains", fixture.errors.unavailable);
  check("indisponibilidade alta", unavailable.status === 503);
  const mismatch = await request("/emails", fixture.a.key, {
    from: fixture.b.from,
    to: "qa@destino.email-e2e.invalid",
  });
  check("conta não usa remetente vizinho", mismatch.status === 403);
  const own = await request("/emails", fixture.a.key, {
    from: fixture.a.from,
    to: "qa@destino.email-e2e.invalid",
    subject: "smoke-conta-propria",
    html: "<p>Sintético</p>",
  });
  check("envio próprio devolve recibo", own.status === 200 && typeof own.body.id === "string");
  const platformKey = "re_e2e_plataforma_legada";
  const platform = await request("/emails", platformKey, {
    from: "envio@plataforma.email-e2e.invalid",
    to: "qa@destino.email-e2e.invalid",
    subject: "smoke-plataforma-legada",
    html: "<p>Sintético</p>",
  });
  check(
    "envio de plataforma preservado",
    platform.status === 200 && typeof platform.body.id === "string",
  );
  const received = (await request("/__duble/recebidos")).body;
  check(
    "autorização só em hash",
    received.requisicoes.some(
      (r) =>
        r.corpo?.subject === "smoke-conta-propria" &&
        r.authorization_sha256 === hash(`Bearer ${fixture.a.key}`),
    ) &&
      received.requisicoes.some(
        (r) =>
          r.corpo?.subject === "smoke-plataforma-legada" &&
          r.authorization_sha256 === hash(`Bearer ${platformKey}`),
      ) &&
      !JSON.stringify(received).includes(fixture.a.key) &&
      !JSON.stringify(received).includes(platformKey),
  );
  process.stdout.write(`${checks} contratos adicionais passaram; sem entrega paga/caixa postal.\n`);
} catch {
  process.stdout.write(
    "Smoke adicional de e-mail recusado; nenhum erro bruto de transporte foi publicado.\n",
  );
  process.exitCode = 1;
}
