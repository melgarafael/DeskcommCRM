# Vínculos B2B pela tela — issue #3198, fatia 1

As imagens abaixo saem de `tests/e2e/b2b-vinculos-pela-tela.spec.ts`: Playwright
num banco local do `baseline.sql`, com dados de teste (`Família E2E …`,
`…@exemplo.test`). Cada execução as reescreve.

Proposta em fatias: @paulolimajr77, no #3198. Análise medida que recomendou a
fatia 1 primeiro: @webtecnica, no mesmo issue.

## 1. Módulo desligado: nada muda

- `1-contato-modulo-desligado.png`: a ficha do contato sem o cartão "Pessoa" e
  sem nenhuma requisição às rotas B2B.

## 2. Pela ficha da pessoa

- `2-contato-sem-pessoa.png`: módulo ligado, o lead do WhatsApp ainda sem pessoa.
- `3-pessoa-adicionar-empresa.png`: "Adicionar a uma empresa" com cargo e decisor.
- `4-pessoa-ligada.png`: a pessoa com a empresa e o telefone ligados.
- `5-contato-com-pessoa.png`: a ficha do contato mostra a pessoa e a empresa.
- `6-empresa-com-pessoa.png`: a ficha da empresa mostra a pessoa.
- `7-empresa-desvinculada.png`: "Remover" desfaz o vínculo; pessoa e empresa ficam.

## 3. Cadastro manual (empresa → pessoa → contato)

- `8-empresa-criar-pessoa-pelo-rodape.png`: nome que não existe; o botão do rodapé
  vira "Criar nova pessoa: <nome>".
- `9-empresa-decisor-editado.png`: "Editar" corrige o decisor esquecido.
- `10-pessoa-novo-contato-telefone-e-email.png`: telefone novo abre "Novo contato"
  com o e-mail no mesmo cadastro.
- `10b-pessoa-telefone-e-email.png`: o contato criado, já ligado à pessoa.
- `10c-empresa-agrupada-por-pessoa.png`: na empresa, telefones e e-mails
  agrupados por pessoa.

## 4. Lead do WhatsApp

- `11-contato-criar-pessoa.png`: "Ligar a uma pessoa" abre com o nome do contato.
- `12-contato-com-pessoa-criada.png`: a pessoa criada e o número ligado a ela.
