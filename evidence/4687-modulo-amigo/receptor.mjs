// Receptor de mentira da API do Amigo para a prova de tela do #4687.
// Escuta só em 127.0.0.1 e grava UMA linha JSON por requisição em RECEBIDO,
// com o que importa para a prova: método, caminho, se o token veio no header
// Authorization, e se ele apareceu na URL ou no corpo. O token em si nunca é
// gravado — só a comparação com AMIGO_TOKEN_FICTICIO.
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const PORTA = Number(process.env.PORTA ?? 4687);
const TOKEN = process.env.AMIGO_TOKEN_FICTICIO ?? "";
const RECEBIDO = process.env.RECEBIDO ?? "recebido.jsonl";
if (!TOKEN) throw new Error("AMIGO_TOKEN_FICTICIO vazio");

const unidade = {
  id: 7, name: "Unidade Fictícia Centro", prefix: null, address_address: null, address_number: null,
  address_district: null, address_city: null, address_state: null, address_complement: null,
};

createServer((req, res) => {
  let corpo = "";
  req.on("data", (c) => (corpo += c));
  req.on("end", () => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORTA}`);
    const auth = req.headers.authorization ?? "";
    appendFileSync(RECEBIDO, JSON.stringify({
      em: new Date().toISOString(),
      metodo: req.method,
      caminho: url.pathname,
      consulta: [...url.searchParams.keys()],
      token_no_header_authorization: auth === `Bearer ${TOKEN}`,
      token_na_url: (req.url ?? "").includes(TOKEN),
      token_no_corpo: corpo.includes(TOKEN),
      outros_headers_com_token: Object.entries(req.headers)
        .filter(([k, v]) => k !== "authorization" && String(v).includes(TOKEN)).map(([k]) => k),
    }) + "\n");
    res.setHeader("content-type", "application/json");
    if (auth !== `Bearer ${TOKEN}`) {
      res.statusCode = 401;
      return res.end(JSON.stringify({ status: "error", message: "unauthorized" }));
    }
    if (req.method === "GET" && url.pathname === "/places") {
      return res.end(JSON.stringify({ status: "success", data: [unidade] }));
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ status: "error", message: "not found" }));
  });
}).listen(PORTA, "127.0.0.1", () => console.info(`receptor do Amigo em 127.0.0.1:${PORTA}`));
