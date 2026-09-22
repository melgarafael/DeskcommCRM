# Fiscal sidecar — emissor de NF-e (sped-nfe)

Micro-serviço PHP que emite NF-e modelo 55 via
[nfephp-org/sped-nfe](https://github.com/nfephp-org/sped-nfe) (`^5.0`).
O app Next **nunca** fala com a SEFAZ direto: ele monta o payload, chama este
serviço na rede privada, e grava o retorno. Sem certificado ou sem este
serviço no ar, as notas ficam `pendente` (o stub honesto) — nunca "autorizada".

> ⚠️ **Validação pendente na VPS.** Este código foi escrito contra a API
> documentada do sped-nfe v5 e **não foi executado aqui** (sem PHP, sem
> certificado, sem SEFAZ nesta máquina). Antes da primeira nota real:
> `composer install` + os 3 passos de [Validação](#validação-na-vps).

## Subir

```bash
cd fiscal/sidecar
cp .env.example .env   # FISCAL_SIDECAR_SECRET=openssl rand -hex 32
docker build -t fiscal-sidecar .
docker run -d --name fiscal --network deskcomm-net \
  -e FISCAL_SIDECAR_SECRET=... \
  -v /srv/fiscal/certs:/certs:ro \
  -p 127.0.0.1:8080:8080 \
  fiscal-sidecar
curl -s http://127.0.0.1:8080/saude
# {"ok":true,"servico":"fiscal-sidecar","sped_nfe":"5.x.x"}
```

**Regras de operação (não negociáveis):**

1. **Nunca exponha a porta para fora.** O serviço escuta em `127.0.0.1` ou em
   rede Docker interna. Quem chama pode emitir nota em nome da empresa.
2. **O `.pfx` entra por SCP** em `/srv/fiscal/certs/` (só leitura). Nunca por
   upload web, nunca no repo, nunca no Storage público.
3. **Comece em homologação** (`ambiente: homologacao` na tela de configuração
   fiscal). Produção só depois de uma nota homologada lida no portal da SEFAZ.
4. **`composer update` com atenção:** NT nova do fisco pode exigir sped-nfe
   novo. Trave testando `/saude` + 1 emissão em homologação depois de cada
   update.

## Contrato

Todas as rotas (exceto `/saude`) exigem `X-Fiscal-Secret`.

### POST /emitir

```json
{
  "config": {
    "ambiente": "homologacao",
    "serie": "1",
    "cnpj": "12345678000190",
    "razao": "Bill Higiene LTDA",
    "ie": "123456789",
    "crt": "1",
    "natureza": "VENDA",
    "cfop": "5102",
    "logradouro": "Rua A", "numero_end": "100", "bairro": "Centro",
    "municipio": "São Paulo", "codigo_municipio": "3550308",
    "uf": "SP", "cep": "01001000"
  },
  "certificado_arquivo": "/certs/empresa.pfx",
  "certificado_senha": "segredo (só em memória, nunca gravado)",
  "pedido": {
    "numero_nota": 123,
    "nome": "Mercado Central",
    "documento": "12987654000100",
    "frete_cents": 0
  },
  "itens": [
    {
      "codigo": "AG-5L", "descricao": "Água Sanitária 5L",
      "ncm": "28289011", "cfop": "5102", "unidade": "UN",
      "quantidade": 2, "preco_cents": 5000, "desconto_pct": 10,
      "csosn": "102"
    }
  ]
}
```

- CRT 1 usa `csosn` (default `102`); CRT 2/3 exige por item `cst` + `aliquota_pct`
  — sem isso, 422 em vez de alíquota chutada.
- Resposta ok: `{ok, chave, protocolo, numero, serie, xml, cstat, xmotivo}`.
- Resposta erro: `{ok:false, codigo, mensagem[, recibo]}`. `LOTE_RECEBIDO`
  significa "lote aceito, recibo pendente" — consultar o recibo é fase futura.

### POST /cancelar

`{config, certificado_arquivo, certificado_senha, chave, protocolo, justificativa}`
→ `{ok, protocolo_cancelamento}` ou `{ok:false, codigo, mensagem}`.

### POST /danfe

`{xml}` → `{ok, pdf_base64}`. Exige `composer require nfephp-org/sped-da`;
sem ele, `DANFE_INDISPONIVEL` (o app mostra "DANFE indisponível" em vez de 500
mudo).

## Validação na VPS

1. `curl /saude` → `sped_nfe` 5.x.
2. Emitir em **homologação** com certificado de teste → conferir `chave` no
   [portal da NF-e](https://www.nfe.fazenda.gov.br/).
3. `POST /danfe` com o XML → abrir o PDF e conferir itens/totais.
4. Só então trocar `ambiente` para `producao` na tela.

## Ligação com o app

- `lib/fiscal/provedor-spednfe.ts` — cliente HTTP deste contrato.
- `FISCAL_SIDECAR_URL` + `FISCAL_SIDECAR_SECRET` no `.env` (ver `.env.example`).
- Sem URL configurada, o app usa o stub — e diz isso na tela, sem fingir.

### POST /distribuicao

`{config, certificado_arquivo, certificado_senha, ult_nsu}` → `{ok, ultNSU, maxNSU, cstat, xmotivo, aviso, documentos[]}`.

Cada chamada faz até 3 consultas à SEFAZ (até 50 docs cada); o app guarda o
`ultNSU` no banco (`fiscal_entrada_cursor`) e continua daqui no próximo
clique — nunca do zero. `aviso: AGUARDAR_1H` (cStat 137/656) = parar por
1h, senão a SEFAZ bloqueia o CNPJ.

Cada documento: `{nsu, tipo, chave, emitente_cnpj, emitente_nome,
emitente_ie, numero, serie, dh_emi, valor_cents, xml, itens[], cobranca[]}`.
`tipo: resumo` (só capa, sem XML — precisa manifestar) · `completa`
(XML + itens + duplicatas) · `evento` (cancelamento, CC-e… — só avança o
cursor, o app não importa evento).

### POST /manifestar

`{config, certificado_arquivo, certificado_senha, chave, evento,
justificativa?}` → `{ok, cstat, manifestacao}`. Eventos: `210200`
confirmação · `210210` ciência · `210220` desconhecimento · `210240`
operação não realizada (exige justificativa 15+). Sem o XML completo não
há itens — e sem itens não há entrada no estoque: manifestar é o passo
que libera a importação.
