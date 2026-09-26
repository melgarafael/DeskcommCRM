# Provedor personalizado (compatível com OpenAI)

Quem roteia a própria IA — **OmniRouter**, **9Router**, **FreellmAPI**, um
LiteLLM hospedado, um proxy corporativo — pode apontar o CRM para o seu
endpoint sem abrir mão de nada: a opção **"Provedor personalizado
(compatível com OpenAI)"** aparece em **IA › Credenciais**, ao lado de
Anthropic, OpenAI, Google, OpenRouter, DeepSeek e Requesty.

## O que preencher

| Campo | O que é |
|---|---|
| **Endereço (base URL)** | A raiz da API compatível com a OpenAI, por exemplo `https://seu-gateway.example/v1`. Em produção precisa começar com `https://`. |
| **Chave** | A chave que aquele endpoint aceita. Guardada cifrada (AES-256-GCM), igual às dos outros provedores: na tela só aparecem os quatro últimos caracteres. |

O endereço mora **na própria credencial**, não em variável de ambiente nem no
painel de provedores — cadastro, teste, validação e o turno do agente leem a
mesma escolha, e duas telas mandando na mesma coisa é como nasce a
configuração que mente.

## O endereço precisa ser público

O endereço é cadastrado por uma **empresa**, e quem chama é o **servidor**.
Por isso ele passa pela mesma régua das outras saídas escolhidas por uma
empresa (webhooks, endereço da visão): não pode apontar para a rede interna
do servidor — `localhost`, `127.0.0.1`, IPs privados (`10.x`, `172.16–31.x`,
`192.168.x`), `169.254.x` (metadados de nuvem) ou um nome que resolve para um
desses, como os serviços do próprio compose. Em produção, só `https://`. E
redirecionamento não é seguido: informe o endereço final.

A régua vale no teste antes de salvar, na validação em segundo plano e em
**cada** chamada do agente, então um nome que passe a resolver para um IP
interno depois de cadastrado é recusado na hora da chamada.

Um LiteLLM ou vLLM rodando na mesma máquina que o CRM, portanto, não entra
por aqui: numa instalação com várias empresas, abrir a rede interna para o
endereço de uma delas deixaria essa empresa ler os serviços internos da
instalação.

## O teste antes de salvar

Ao clicar em **Salvar e validar**, a tela primeiro chama
`POST /api/v1/ai/credentials/test`, que faz `GET {base}/models` com timeout de
10 segundos:

- **deu certo** → mostra a conexão confirmada e a quantidade de modelos que o
  endpoint devolveu, e só então grava;
- **deu errado** → nada é gravado, e a frase do erro aparece no campo, do lado
  do endereço.

Depois de gravar, a validação em segundo plano roda a MESMA chamada sobre a
linha salva e atualiza o cartão — se a chave for trocada depois, é ela de novo
que prova.

O endpoint precisa responder `GET /models` autenticado. Se o seu gateway não
tem essa rota, o teste dirá isso (`Este endereço não respondeu em /models`) —
é o sinal de que a base URL aponta para um caminho que não existe.

## Usando no agente

Escolha **Provedor personalizado** como empresa de IA na tela do assistente,
selecione a credencial, digite o id do modelo (a lista vem do que o endpoint
devolveu no teste) e publique. O ensaio e a mensagem de verdade vão para o
mesmo endereço.

Os quatro provedores nativos não mudam nada: continua valendo para eles o que
sempre valeu.
