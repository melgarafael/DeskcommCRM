import { z } from "zod";

const OPCAO_MAX = 100;
const CHAVE_MAX = 40;

export const webhookFormFieldSchema = z
  .object({
    key: z
      .string()
      .trim()
      .min(1)
      .max(CHAVE_MAX)
      .regex(/^[a-z][a-z0-9_]*$/, "Use uma chave iniciada por letra minúscula, sem espaços."),
    label: z.string().trim().min(1, "Escreva o texto da pergunta.").max(120),
    type: z.enum(["text", "textarea", "number", "currency", "select", "checkbox"]),
    required: z.boolean().default(false),
    options: z.array(z.string().trim().min(1).max(OPCAO_MAX)).max(30).optional(),
  })
  .strict()
  .superRefine((field, ctx) => {
    const reservado = new Set([
      "name", "nome", "full_name", "fullname", "phone", "telefone", "whatsapp", "celular",
      "phone_number", "tel", "email", "e-mail", "mail", "external_id", "submission_status",
      "ai_service_consent", "ai_service_consent_version",
    ]);
    if (reservado.has(field.key) || field.key.startsWith("utm_") || field.key.startsWith("__")) {
      ctx.addIssue({ code: "custom", path: ["key"], message: "Essa chave é reservada pelo formulário ou pelo CRM." });
    }
    if (field.type === "select" && (!field.options || field.options.length === 0)) {
      ctx.addIssue({ code: "custom", path: ["options"], message: "Adicione pelo menos uma opção para a lista." });
    }
    if (field.type !== "select" && field.options?.length) {
      ctx.addIssue({ code: "custom", path: ["options"], message: "As opções só se aplicam ao campo de lista." });
    }
    if (field.options && new Set(field.options.map((option) => option.toLocaleLowerCase())).size !== field.options.length) {
      ctx.addIssue({ code: "custom", path: ["options"], message: "Remova opções repetidas." });
    }
  });

export const webhookFormFieldsSchema = z
  .array(webhookFormFieldSchema)
  .max(20, "O formulário pode ter até 20 perguntas.")
  .superRefine((fields, ctx) => {
    const vistos = new Set<string>();
    for (const [index, field] of fields.entries()) {
      if (vistos.has(field.key)) {
        ctx.addIssue({ code: "custom", path: [index, "key"], message: "Cada pergunta precisa ter uma chave diferente." });
      }
      vistos.add(field.key);
    }
  });

export type WebhookFormField = z.infer<typeof webhookFormFieldSchema>;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const entidades: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entidades[char] ?? char;
  });
}

/** Gera um formulário HTML plano; os valores passam a ser campos personalizados do lead. */
export function gerarHtmlDoFormulario(
  endpoint: string,
  fields: readonly WebhookFormField[],
  textos: { nome: string; telefone: string; email: string; enviar: string; selecione: string },
): string {
  const required = (value: boolean) => (value ? " required" : "");
  const extra = fields
    .map((field) => {
      const key = escapeHtml(field.key);
      const label = escapeHtml(field.label);
      const id = `webhook-form-${key}`;
      if (field.type === "textarea") {
        return `  <label for="${id}">${label}</label>\n  <textarea id="${id}" name="${key}" rows="4"${required(field.required)}></textarea>`;
      }
      if (field.type === "select") {
        const options = (field.options ?? [])
          .map((option) => `    <option value="${escapeHtml(option)}">${escapeHtml(option)}</option>`)
          .join("\n");
        return `  <label for="${id}">${label}</label>\n  <select id="${id}" name="${key}"${required(field.required)}>\n    <option value="">${escapeHtml(textos.selecione)}</option>\n${options}\n  </select>`;
      }
      if (field.type === "checkbox") {
        // O hidden vem antes do checkbox: no envio, o valor checked (true) vence;
        // desmarcado continua registrando false em vez de desaparecer do payload.
        return `  <input type="hidden" name="${key}" value="false" />\n  <label for="${id}"><input id="${id}" type="checkbox" name="${key}" value="true"${required(field.required)} /> ${label}</label>`;
      }
      if (field.type === "number") {
        return `  <label for="${id}">${label}</label>\n  <input id="${id}" name="${key}" type="text" inputmode="decimal" pattern="[0-9]+([.][0-9]+)?" data-form-number="true"${required(field.required)} />`;
      }
      if (field.type === "currency") {
        return `  <label for="${id}">${label}</label>\n  <input id="${id}" name="${key}" type="text" inputmode="decimal" autocomplete="off" data-form-currency="brl" placeholder="R$ 0,00"${required(field.required)} />`;
      }
      return `  <label for="${id}">${label}</label>\n  <input id="${id}" name="${key}" type="text"${required(field.required)} />`;
    })
    .join("\n");

  const currencyScript = fields.some((field) => field.type === "currency" || field.type === "number")
    ? `\n<script>\n(() => {\n  const form = document.currentScript.previousElementSibling;\n  const fields = form.querySelectorAll('[data-form-currency="brl"]');\n  const numbers = form.querySelectorAll('[data-form-number="true"]');\n  const format = (input) => {\n    const raw = input.value.trim().replace(/^R\\$\\s*/i, '').replace(/\\s/g, '');\n    if (!raw) return;\n    if (!/^(?:\\d+|\\d{1,3}(?:\\.\\d{3})+)(?:,\\d{1,2})?$/.test(raw)) return;\n    const normalized = raw.includes(',') ? raw.replace(/\\./g, '').replace(',', '.') : raw.replace(/\\./g, '');\n    const value = Number(normalized);\n    if (Number.isFinite(value)) input.value = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);\n  };\n  fields.forEach((input) => {\n    input.addEventListener('input', () => { input.value = input.value.replace(/[^0-9,.\\sR$-]/g, ''); });\n    input.addEventListener('blur', () => format(input));\n  });\n  numbers.forEach((input) => input.addEventListener('input', () => { input.value = input.value.replace(/,/g, '.').replace(/[^0-9.]/g, '').replace(/(\\..*)\\./g, '$1'); }));\n  form.addEventListener('submit', () => fields.forEach(format));\n})();\n</script>`
    : "";

  return `<form action="${escapeHtml(endpoint)}" method="POST">
  <label for="webhook-form-nome">${escapeHtml(textos.nome)}</label>
  <input id="webhook-form-nome" name="nome" type="text" required />
  <label for="webhook-form-telefone">${escapeHtml(textos.telefone)}</label>
  <input id="webhook-form-telefone" name="telefone" type="tel" required />
  <label for="webhook-form-email">${escapeHtml(textos.email)}</label>
  <input id="webhook-form-email" name="email" type="email" />${extra ? `\n${extra}` : ""}
  <button type="submit">${escapeHtml(textos.enviar)}</button>
</form>${currencyScript}`;
}

export type ValorNumericoWebhook = { ok: true; value: number | null } | { ok: false };

/** Converte e valida número decimal enviado por um campo numérico configurado. */
export function normalizarNumeroDeFormulario(value: unknown): ValorNumericoWebhook {
  if (value === undefined || value === null || value === "") return { ok: true, value: null };
  if (typeof value === "number") {
    return Number.isFinite(value) ? { ok: true, value } : { ok: false };
  }
  if (typeof value !== "string") return { ok: false };
  const raw = value.trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(raw)) return { ok: false };
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? { ok: true, value: parsed } : { ok: false };
}

/** Converte BRL em número JSON, aceitando o formato exibido no formulário. */
export function normalizarMoedaBRLDeFormulario(value: unknown): ValorNumericoWebhook {
  if (value === undefined || value === null || value === "") return { ok: true, value: null };
  if (typeof value === "number") {
    return Number.isFinite(value) ? { ok: true, value } : { ok: false };
  }
  if (typeof value !== "string") return { ok: false };
  const raw = value.trim().replace(/^R\$\s*/i, "").replace(/\s/g, "");
  if (!raw) return { ok: true, value: null };
  if (!/^(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d{1,2})?$/.test(raw)) return { ok: false };
  const parsed = Number(raw.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(parsed) && parsed >= 0 ? { ok: true, value: parsed } : { ok: false };
}

/** Dá o valor de uma chave do payload sem diferenciar maiúsculas/minúsculas. */
export function valorDoPayload(payload: Record<string, unknown>, key: string): unknown {
  if (Object.prototype.hasOwnProperty.call(payload, key)) return payload[key];
  const actualKey = Object.keys(payload).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
  return actualKey === undefined ? undefined : payload[actualKey];
}

/** Normaliza os valores numéricos dos campos configurados e reporta os inválidos. */
export function normalizarCamposNumericos(
  payload: Record<string, unknown>,
  fields: readonly WebhookFormField[],
): { values: Record<string, number | null>; invalidKeys: string[] } {
  const values: Record<string, number | null> = {};
  const invalidKeys: string[] = [];
  for (const field of fields) {
    if (field.type !== "number" && field.type !== "currency") continue;
    const raw = valorDoPayload(payload, field.key);
    if (raw === undefined) continue;
    const result = field.type === "currency"
      ? normalizarMoedaBRLDeFormulario(raw)
      : normalizarNumeroDeFormulario(raw);
    if (result.ok) values[field.key] = result.value;
    else invalidKeys.push(field.key);
  }
  return { values, invalidKeys };
}
