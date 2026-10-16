/**
 * As guardas puras das imagens da resposta rápida (#2526).
 *
 * `midiaPertenceAoTemplate` é o que impede o PATCH/DELETE de apagar, por
 * service role, um arquivo que não é deste template. `conferirMidias` é o que
 * impede o PATCH de cadastrar um caminho que nenhum upload conferiu.
 */
import { describe, expect, it } from "vitest";

import { conferirMidias, midiaPertenceAoTemplate, type MidiaDeTemplate } from "@/lib/templates/midias";

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA_ORG = "33333333-3333-4333-8333-333333333333";
const TPL = "22222222-2222-4222-8222-222222222222";
const OUTRO_TPL = "44444444-4444-4444-8444-444444444444";
const ARQ = "0a0b0c0d-0000-4000-8000-000000000001";
const proprio = `${ORG}/templates/${TPL}/${ARQ}.jpg`;

describe("midiaPertenceAoTemplate", () => {
  it("aceita o caminho que a rota gera (jpg e png)", () => {
    expect(midiaPertenceAoTemplate(proprio, ORG, TPL)).toBe(true);
    expect(midiaPertenceAoTemplate(proprio.replace(".jpg", ".png"), ORG, TPL)).toBe(true);
  });

  it.each([
    ["outra organização", `${OUTRA_ORG}/templates/${TPL}/${ARQ}.jpg`],
    ["outro template", `${ORG}/templates/${OUTRO_TPL}/${ARQ}.jpg`],
    ["subida de diretório", `${ORG}/templates/${TPL}/../${OUTRO_TPL}/${ARQ}.jpg`],
    ["segmento extra", `${ORG}/templates/${TPL}/sub/${ARQ}.jpg`],
    ["extensão fora da lista", `${ORG}/templates/${TPL}/${ARQ}.gif`],
    ["uuid malformado", `${ORG}/templates/${TPL}/nao-e-uuid.jpg`],
    ["prefixo de conversa", `${ORG}/conv/${ARQ}.jpg`],
  ])("recusa %s", (_caso, caminho) => {
    expect(midiaPertenceAoTemplate(caminho, ORG, TPL)).toBe(false);
  });
});

describe("conferirMidias", () => {
  const m = (n: number, mime = "image/jpeg"): MidiaDeTemplate => ({
    storage_path: `${ORG}/templates/${TPL}/0a0b0c0d-0000-4000-8000-00000000000${n}.jpg`,
    media_mime: mime,
    media_size_bytes: n,
  });
  const atual = [m(1), m(2), m(3)];

  it("calcula as removidas e devolve as mantidas a partir da LINHA", () => {
    const forjada = { ...m(3), media_mime: "text/html", media_size_bytes: 999 };
    const r = conferirMidias(atual, [forjada, m(1)]);
    expect(r).toEqual({ ok: true, mantidas: [m(3), m(1)], removidas: [m(2).storage_path] });
  });

  it("recusa caminho que não está na linha (só remove, nunca acrescenta)", () => {
    expect(conferirMidias(atual, [m(1), m(4)])).toEqual({ ok: false });
  });

  it("recusa duplicata", () => {
    expect(conferirMidias(atual, [m(1), m(1)])).toEqual({ ok: false });
  });

  it("recusa mais de 5", () => {
    const seis = [1, 2, 3, 4, 5, 6].map((n) => m(n));
    expect(conferirMidias(seis, seis)).toEqual({ ok: false });
  });

  it("lista vazia remove tudo", () => {
    expect(conferirMidias(atual, [])).toEqual({
      ok: true,
      mantidas: [],
      removidas: atual.map((a) => a.storage_path),
    });
  });
});
