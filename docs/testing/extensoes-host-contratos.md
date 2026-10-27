# Compatibilidade dos contratos de extensões — #3477

Destino: **ambos**. O host preserva a leitura dos pacotes existentes e o consumidor
Consulta de laudos usa o contrato novo já aprovado. Não há capacidade, concessão ou
efeito novo neste reparo. A contribuição e os créditos de #3474/#3076/#3063 continuam
preservados; #3063 permanece aberto enquanto o destino completo não for entregue.

## Prova local observada

`lib/extensions/host-api-contratos.test.ts` importa dois leitores executáveis:

- o parser real API2 de `271a327efe9d0f4532657f3007a6e751306986bd`, capturado em
  `tests/fixtures/extensoes/leitor-api2/`, com hashes e uma relocação de import
  documentada em `proveniencia.json`;
- o parser atual de `lib/extensions/manifest.ts`, com os contratos fechados 2 e 3.

Os dois recebem os mesmos bytes dos snapshots. Não é uma simulação das regras de
parse e não é uma execução de dois hosts completos.

| Leitor | Snapshot com três pacotes API2 | Snapshot com quatro, laudos API3 | Retorno com três e revisão maior |
| --- | --- | --- | --- |
| API2 congelado | Aceita | Recusa enum desconhecido | Aceita |
| Atual API2+API3 | Aceita | Aceita | Aceita |

O feed legado tem 3379 bytes e SHA256
`732fa4d6c1d3ef9d0237e00b1dcb25899d809d90c48add2f5f56654e713460f7`.
Os três artefatos conservam os hashes e tamanhos declarados nele. O catálogo
candidato foi produzido pelo gerador existente, revisão 4 / SHA256
`e34e04b480ae662cbd9662b33aa61a3866a751f8090fc31b45312824539484b2`.
O snapshot de retorno proposto usa a mesma origem e entradas, revisão 5 / SHA256
`d210d782d56d9b2ed66c09b0711f828285d0c1a564e10705cdd212b5b24ad5f3`.
Candidato e retorno **não foram publicados**. A revisão do retorno precisa
continuar maior que a máxima já admitida na instalação de destino; este ensaio
não permite reduzir revisões nem reutilizar uma revisão com outros bytes.

A previsão foi registrada antes de cada sabotagem. Primeiro, a matriz de 14 casos
teve 8 falhas / 6 controles verdes; os mesmos casos passaram após o reparo. A matriz
final usa os snapshots reais e inclui a pré-checagem parcial e o retorno: retirar
API3 e a recusa de turno anunciado em API2 produziu exatamente 11 falhas / 7 controles
verdes. O código foi restaurado byte a byte. A rodada final passou 120 casos em
sete arquivos, um worker, incluindo os 18 casos da matriz. Esses resultados não
provam admissão persistida, concorrência nem navegador.

## Banco e tipos observados

A bancada própria PostgreSQL 17.11 aplicou e reaplicou o baseline combinado com
`ON_ERROR_STOP=1`. A CLI 2.122.0 produziu dois arquivos brutos integrais idênticos,
SHA256 `03f8719e3dadffbc4b491448823a82b981622ec52c45da5af43bf3104d70da68`.
Os dois passaram pelo Prettier canônico, também com bytes idênticos, SHA256
`4107ae4613981137ea860ba839144c3ee6a720d92f8549c5723cd0ed99aa8c07`.
O arquivo gerado inteiro substituiu o anterior. A comparação por AST preservou
os 11.632 membros canônicos e as constantes, acrescentando somente a coluna
`accepted_permissions` em Row/Insert/Update e o argumento da RPC.

Na mesma bancada, a configuração e o setup canônicos executaram oito casos de
`extensoes-turno-consentimento.test.ts` e dois casos existentes de concorrência
em `extensoes-declarativas.test.ts`: dez passaram, 37 não foram selecionados,
um worker. O clone limpo por arquivo e a reaplicação do baseline foram reais,
por túnel loopback e transporte SSH dos dois comandos psql canônicos ao
contêiner próprio; nenhum Docker local ou mock de SQL foi usado. O contêiner
e o túnel foram encerrados e a porta liberada. Isso não é a suíte completa de
banco, uma rodada PG15 ou prova de interface e retorno entre hosts.

## Interface e retorno ainda pendentes

O roteiro abaixo depende da bancada serial autorizada pela manutenção. Não foi
executado por esta prova local; não há novas capturas para citar.

1. Usar os atores e receivers locais reais da suíte. A origem local remapeada
   deve ser a mesma nos três snapshots; registrar essa transformação separada
   dos bytes públicos preservados na matriz. Pacotes continuam byte idênticos.
2. Admitir o snapshot com três pela UI normal e instalar/ativar seus artefatos.
   Conferir guias, configuração e ausência de alteração na outra organização.
   Um leitor API2 deve recusar os bytes com quatro antes da RPC; a prova deve
   comparar id, revisão, digest e snapshot admitido antes/depois dessa recusa.
3. No host novo, admitir a revisão seguinte com quatro e executar TL01–TL07:
   instalar não concede envio/passagem/contexto; as concessões continuam
   explícitas; envio/passagem não incluem o aceite de contexto, com os mesmos controles de tenant, contexto, idempotência e SDKs
   HTTP reais. Preservar o orçamento existente, sem pagamento ou credencial real.
4. Remover laudos pela gestão com revisão esperada e recibo. Conferir remoção
   lógica, vínculos desligados e configuração/histórico preservados. Só então
   admitir o retorno de três com revisão crescente da mesma origem, pela porta
   normal, sem SQL manual. Conferir os três guias e sua configuração.
5. Conferir o retorno em host API2 real, pinado por versão/digest, sem restaurar
   backup sobre o banco nem rebaixar sua revisão. Um card incompatível não pode
   derrubar a gestão; os três instalados devem continuar utilizáveis. Essa etapa
   não é substituída pela matriz dos parsers.

O feed público de três continua congelado e a manutenção controla o payload e a
publicação externos. Nenhum resultado deste documento libera Ready, merge ou
publicação do quarto pacote sem os gates e as provas reais restantes.
