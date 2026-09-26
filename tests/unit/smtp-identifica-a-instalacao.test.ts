// @vitest-environment node
import { createServer, type Server, type Socket } from "node:net";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SmtpConfig } from "@/lib/email/config";

const estado = vi.hoisted(() => ({
  env: { NEXT_PUBLIC_APP_URL: "https://crm.example.com" },
  config: {} as SmtpConfig,
}));
vi.mock("@/lib/env", () => ({ env: estado.env }));
vi.mock("@/lib/email/config", () => ({ getSmtpConfig: async () => estado.config }));

// Nodemailer REAL falando com um receptor SMTP local. O teste mede o EHLO no
// fio, não apenas a presença de uma opção em um mock de createTransport.
let servidor: Server;
let sockets: Set<Socket>;
let saudacoes: string[];
let mensagens: string[];

beforeEach(async () => {
  vi.resetModules();
  vi.spyOn(os, "hostname").mockReturnValue("21ce6ab200ec"); // hostname Docker curto
  estado.env.NEXT_PUBLIC_APP_URL = "https://crm.example.com";
  sockets = new Set();
  saudacoes = [];
  mensagens = [];
  servidor = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    socket.write("220 smtp.example.test ESMTP\r\n");
    let buffer = "";
    let emDados = false;
    let mensagem = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let fim: number;
      while ((fim = buffer.indexOf("\r\n")) >= 0) {
        const linha = buffer.slice(0, fim);
        buffer = buffer.slice(fim + 2);
        if (emDados) {
          if (linha === ".") {
            mensagens.push(mensagem);
            mensagem = "";
            emDados = false;
            socket.write("250 2.0.0 accepted\r\n");
          } else mensagem += `${linha}\r\n`;
        } else if (/^(EHLO|HELO) /.test(linha)) {
          saudacoes.push(linha);
          socket.write("250 smtp.example.test\r\n");
        } else if (linha === "DATA") {
          emDados = true;
          socket.write("354 End with a dot\r\n");
        } else if (linha === "QUIT") {
          socket.end("221 Bye\r\n");
        } else socket.write("250 OK\r\n");
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    servidor.once("error", reject);
    servidor.listen(0, "127.0.0.1", resolve);
  });
  const address = servidor.address();
  if (!address || typeof address === "string") throw new Error("SMTP local sem porta");
  estado.config = {
    host: "127.0.0.1",
    port: address.port,
    security: "none",
    username: "",
    password: "",
    fromEmail: "convites@example.com",
    fromName: "CRM de teste",
    source: "database",
  };
});

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => servidor.close(() => resolve()));
  vi.restoreAllMocks();
});

const convite = {
  to: "pessoa@example.net",
  subject: "Convite de teste local",
  html: "<p>Você recebeu um convite.</p>",
};

describe("identidade SMTP da instalação", () => {
  it("envia com o domínio público, mesmo com hostname Docker curto", async () => {
    const { sendEmail } = await import("@/lib/email/smtp");
    expect(await sendEmail(convite)).toMatchObject({ ok: true, id: expect.any(String) });
    expect(saudacoes).toEqual(["EHLO crm.example.com"]);
    expect(mensagens).toHaveLength(1);
    expect(mensagens[0]).toContain("<convites@example.com>");
  });

  it("a verificação usa a mesma identidade e não envia mensagem", async () => {
    const { checkSmtpConfiguration } = await import("@/lib/email/smtp");
    expect(await checkSmtpConfiguration()).toEqual({ ok: true });
    expect(saudacoes).toEqual(["EHLO crm.example.com"]);
    expect(mensagens).toHaveLength(0);
  });

  it.each([
    ["https://crm.example.org:8443/base?origem=teste#inicio", "crm.example.org"],
    ["http://192.0.2.10:3000", "[192.0.2.10]"],
    ["http://[2001:db8::10]:3000", "[IPv6:2001:db8::10]"],
    ["http://localhost:3000", "[127.0.0.1]"],
    ["http://crm:3000", "[127.0.0.1]"],
  ])("usa apenas a identidade de %s: %s", async (url, nome) => {
    estado.env.NEXT_PUBLIC_APP_URL = url;
    const { sendEmail } = await import("@/lib/email/smtp");
    expect(await sendEmail(convite)).toMatchObject({ ok: true });
    expect(saudacoes).toEqual([`EHLO ${nome}`]);
  });

  it("o cache não conserva uma identidade de domínio anterior", async () => {
    const { sendEmail } = await import("@/lib/email/smtp");
    expect(await sendEmail(convite)).toMatchObject({ ok: true });
    estado.env.NEXT_PUBLIC_APP_URL = "https://outro.example.org";
    expect(await sendEmail(convite)).toMatchObject({ ok: true });
    expect(saudacoes).toEqual(["EHLO crm.example.com", "EHLO outro.example.org"]);
  });

  it("sem SMTP configurado não tenta abrir conexão nem afirma envio", async () => {
    estado.config.fromEmail = "";
    const { sendEmail, checkSmtpConfiguration } = await import("@/lib/email/smtp");
    expect(await sendEmail(convite)).toEqual({ ok: false, error: "not_configured" });
    expect(await checkSmtpConfiguration()).toEqual({ ok: false, reason: "not_configured" });
    expect(saudacoes).toEqual([]);
    expect(mensagens).toEqual([]);
  });
});
