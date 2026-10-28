/** SDK real → HTTP real, transporte sintético local. Não prova banco, UX ou caixa de e-mail. */
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { expect, it, vi } from "vitest";

import { enviarPelaContaDaOrganizacao, verificarDominioNaResend } from "./resend-da-organizacao";

it("a SDK entrega ao receiver o remetente e a chave de cada conta, sem misturar as organizações", async () => {
  const recebidos: { metodo: string; caminho: string; authHash: string; corpo: unknown }[] = [];
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const receiver = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const corpo = Buffer.concat(chunks).toString("utf8");
    recebidos.push({
      metodo: req.method ?? "",
      caminho: req.url ?? "",
      authHash: hash(req.headers.authorization ?? ""),
      corpo: corpo ? JSON.parse(corpo) : null,
    });
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify(
        req.url === "/domains"
          ? {
              data: [{ id: "dominio-a", name: "empresa-a.example", status: "verified" }],
              has_more: false,
            }
          : { id: `receiver-${recebidos.length}` },
      ),
    );
  });
  await new Promise<void>((resolve, reject) => {
    receiver.once("error", reject);
    receiver.listen(0, "127.0.0.1", resolve);
  });
  const endereco = receiver.address();
  if (!endereco || typeof endereco === "string") throw new Error("receiver sem porta TCP");
  vi.stubEnv("RESEND_BASE_URL", `http://127.0.0.1:${endereco.port}`);
  try {
    await expect(
      verificarDominioNaResend("re_sintetica_org_a", "envio@empresa-a.example"),
    ).resolves.toEqual({ ok: true });
    for (const org of ["a", "b"]) {
      await expect(
        enviarPelaContaDaOrganizacao(
          { apiKey: `re_sintetica_org_${org}`, fromEmail: `envio@empresa-${org}.example` },
          {
            to: `cliente-${org}@destino.example`,
            subject: "Assunto sintético",
            html: "<p>Olá</p>",
            text: "Olá",
            fromName: `Empresa ${org}`,
            replyTo: `resposta-${org}@outro.example`,
          },
        ),
      ).resolves.toMatchObject({ ok: true, id: expect.stringMatching(/^receiver-/) });
    }
    expect(recebidos).toHaveLength(3);
    expect(recebidos[0]).toMatchObject({
      metodo: "GET",
      caminho: "/domains",
      authHash: hash("Bearer re_sintetica_org_a"),
    });
    for (const [index, org] of ["a", "b"].entries()) {
      expect(recebidos[index + 1]).toMatchObject({
        metodo: "POST",
        caminho: "/emails",
        authHash: hash(`Bearer re_sintetica_org_${org}`),
        corpo: {
          from: `Empresa ${org} <envio@empresa-${org}.example>`,
          to: `cliente-${org}@destino.example`,
          reply_to: `resposta-${org}@outro.example`,
          html: "<p>Olá</p>",
          text: "Olá",
        },
      });
    }
  } finally {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve, reject) => {
      receiver.close((error) => (error ? reject(error) : resolve()));
      receiver.closeAllConnections();
    });
  }
});
