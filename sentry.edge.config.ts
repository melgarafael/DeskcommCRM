// This file configures the initialization of Sentry for edge features (middleware, edge routes, and so on).
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";

const SENSITIVE_HEADERS = [
  "authorization",
  "cookie",
  "x-api-key",
  "x-waha-api-key",
  "x-nuvemshop-token",
  "x-deskcomm-token",
];

function scrubMessage(input: string): string {
  return input
    .replace(/\d{3}\.?\d{3}\.?\d{3}-?\d{2}/g, "[CPF]")
    .replace(/\+?\d{2}\s?\d{4,5}-?\d{4}/g, "[PHONE]")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[EMAIL]");
}

Sentry.init({
  dsn: "https://58fabf8ad54504863d404a3647ef3714@o4509908078559232.ingest.us.sentry.io/4509908083212288",

  tracesSampleRate: 1,
  enableLogs: true,
  sendDefaultPii: false,

  beforeSend(event) {
    if (event.request?.headers) {
      const headers = event.request.headers as Record<string, string>;
      for (const k of Object.keys(headers)) {
        if (SENSITIVE_HEADERS.includes(k.toLowerCase())) {
          delete headers[k];
        }
      }
    }
    if (typeof event.message === "string") {
      event.message = scrubMessage(event.message);
    }
    if (event.exception?.values) {
      for (const ex of event.exception.values) {
        if (ex.value) ex.value = scrubMessage(ex.value);
      }
    }
    return event;
  },
});
