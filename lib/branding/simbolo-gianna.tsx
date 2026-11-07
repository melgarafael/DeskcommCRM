import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Ícone original da Gianna, enquadrado sem alterar o arquivo enviado. */
export function simboloGianna(lado: number) {
  const imagem = readFileSync(join(process.cwd(), "public/gianna/simbolo.png")).toString("base64");
  const escala = lado / 340;
  return (
    <div style={{ position: "relative", width: lado, height: lado, overflow: "hidden", display: "flex" }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        alt=""
        src={`data:image/png;base64,${imagem}`}
        width={1920 * escala}
        height={1080 * escala}
        style={{ position: "absolute", left: -790 * escala, top: -373 * escala }}
      />
    </div>
  );
}
