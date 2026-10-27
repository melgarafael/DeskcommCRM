# SPEC — Envios (vídeo, arte, roteiro e aviso para o cliente, dentro do sistema)

> Item 1 do [plano de ajustes de 27/10/2026](plano-ajustes-2026-10-27.md). Decisões do dono:
> vídeo de até 2 GB; Drive desconectado deixa o arquivo na VPS até conectar; o botão se chama
> "Envios"; texto em duas formas (roteiro para aprovar, aviso para dar ciência).

## O que resolve

Hoje a aprovação manda um **link** (do Drive), e o cliente sai do sistema para ver. Agora a
agência sobe o vídeo ou a arte **para a VPS**, ou escreve o roteiro ou o aviso, e o cliente vê
tudo **dentro** da aba Aprovações da organização dele. Depois da aprovação, o arquivo vai para o
Drive e sai da VPS.

## Regras

| # | Regra |
|---|---|
| E1 | O menu da agência ganha **Envios** (`/agencia/envios`), que pede `tarefas.criar` (a mesma porta de pedir aprovação). A pessoa só vê e envia para os clientes que alcança. |
| E2 | Tipos: **vídeo** (mp4, mov ou webm, até **2 GB**), **arte** (jpg, png ou webp, até 50 MB), **roteiro** (texto), **estratégia** (texto ou arquivo) e **aviso** (texto). O link do Drive continua aceito como alternativa, para não quebrar o que já existe. |
| E3 | O arquivo vai do navegador **direto ao Storage** da VPS (bucket privado `agencia-envios`), em partes de 6 MB (protocolo TUS), com barra de progresso e retomada se cair. O servidor só assina a permissão de envio, que vale para um caminho e por tempo curto, e depois confere que o objeto chegou, no caminho do cliente e com o tamanho declarado. |
| E4 | O cliente vê por **link assinado de 3 horas**, gerado no servidor a cada vez que abre a tela. O vídeo toca no player com a descrição ao lado; a arte abre grande; o roteiro e o aviso aparecem como texto. |
| E5 | **Roteiro, vídeo, arte e estratégia:** o cliente aprova ou pede ajustes. Quando pede ajustes, a agência manda a **nova versão** (v2, v3…), ligada à anterior. **Aviso:** o cliente só clica em **"Ciente"**, e fica registrado quem e quando. |
| E6 | **Aprovou** → o envio entra na fila de cópia para o Drive, na subpasta do cliente: vídeo em "06 Edições", arte em "07 Artes", roteiro e estratégia em "03 Planejamento" (texto em `.txt`). A cópia é **em partes e retomável**: lê o Storage por faixa de bytes e grava numa sessão resumível do Drive, e pode continuar na rodada seguinte do relógio. Ela começa logo depois da resposta e o relógio da agência (a cada 15 min) termina o que faltar. |
| E7 | **Só depois de o Drive confirmar** o arquivo com o mesmo tamanho, o sistema apaga da VPS o arquivo aprovado **e** as versões anteriores da mesma cadeia. Se o Drive estiver desconectado ou a cópia falhar, nada se apaga: o envio mostra "Aguardando o Drive", e a agência é avisada uma vez. |
| E8 | Cancelar um envio pendente apaga o arquivo dele da VPS (ninguém aprovou; não há o que guardar). |
| E9 | O estado da cópia (sessão resumível, bytes enviados, erro) fica numa tabela da **instalação** (`agencia_envios_copias`), fora do alcance do cliente: a URL da sessão do Drive permite gravar, e a tabela de aprovações é legível pela organização. |
| E10 | O aviso de WhatsApp ao cliente continua igual (grupo ou responsável), com texto próprio para o aviso. |

## Dados (migration 9013)

- `agencia_aprovacoes`:
  - colunas novas: `texto`, `arquivo_caminho`, `arquivo_nome`, `arquivo_mime`,
    `arquivo_bytes`, `arquivo_apagado_em`;
  - o tipo ganha `aviso` e a situação ganha `ciente`.
- `agencia_envios_copias`: `aprovacao_id`, situação (`aguardando`, `copiando`, `copiado`,
  `falhou`), `sessao`, `enviados`, `tentativas`, `drive_arquivo_id`, `drive_link`, `erro` e
  `avisado_em`. É tabela da instalação, sem acesso de anon/authenticated.
- Bucket `agencia-envios`, privado, com limite de 2 GB. Ele nasce na migration e no baseline,
  só se o schema `storage` existir.
- O limite global do Storage da instalação sobe para 2 GB no override do kit
  (`STORAGE_FILE_SIZE_LIMIT`, com padrão de 2 GB).

## O que NÃO está provado (até a prova da fase)

A cópia real para o Drive depende de o Google estar conectado no teste (pendência do dono).
Sem ele, a prova mostra o envio esperando o Drive com o arquivo preservado.
