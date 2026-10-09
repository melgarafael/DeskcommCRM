import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verificarAssinaturaAuth } from "./assinatura-auth";

const chave = Buffer.alloc(32, 7);
const segredo = `v1,whsec_${chave.toString("base64")}`;
const agora = 1800000000000;
const corpo = '{"user": {"id":"sintetico"}}';
function headers(id = "msg_teste", timestamp = "1800000000") {
  const sig = createHmac("sha256", chave).update(`${id}.${timestamp}.${corpo}`).digest("base64");
  return new Headers({
    "webhook-id": id,
    "webhook-timestamp": timestamp,
    "webhook-signature": `v1,${sig}`,
  });
}
describe("assinatura Standard Webhooks Auth", () => {
  it("valida corpo bruto e formato Cloud", () => {
    expect(verificarAssinaturaAuth(corpo, headers(), segredo, agora)).toBe("msg_teste");
    expect(
      verificarAssinaturaAuth(JSON.stringify(JSON.parse(corpo)), headers(), segredo, agora),
    ).toBeNull();
  });
  it("recusa corpo, id, timestamp ou chave adulterados", () => {
    expect(verificarAssinaturaAuth(corpo + " ", headers(), segredo, agora)).toBeNull();
    for (const nome of ["webhook-id", "webhook-timestamp", "webhook-signature"]) {
      const h = headers();
      h.set(nome, "adulterado");
      expect(verificarAssinaturaAuth(corpo, h, segredo, agora)).toBeNull();
    }
    expect(
      verificarAssinaturaAuth(
        corpo,
        headers(),
        "v1,whsec_" + Buffer.alloc(32, 8).toString("base64"),
        agora,
      ),
    ).toBeNull();
    expect(verificarAssinaturaAuth(corpo, headers(), "", agora)).toBeNull();
  });
  it.each(["1799999699", "1800000301", "1800000000.0"])(
    "recusa timestamp fora do contrato %s",
    (timestamp) => {
      expect(
        verificarAssinaturaAuth(corpo, headers("msg_teste", timestamp), segredo, agora),
      ).toBeNull();
    },
  );
  it("aceita múltiplas assinaturas para rotação e recusa id com ponto", () => {
    const h = headers();
    h.set("webhook-signature", `v2,ignorar ${h.get("webhook-signature")}`);
    expect(verificarAssinaturaAuth(corpo, h, segredo, agora)).toBe("msg_teste");
    expect(verificarAssinaturaAuth(corpo, headers("msg.teste"), segredo, agora)).toBeNull();
  });
});
