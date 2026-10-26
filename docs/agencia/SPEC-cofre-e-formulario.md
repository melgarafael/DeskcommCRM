# Spec: `cofre-de-acessos` e `formulario` — os acessos do cliente

> Fase 5 do [mapa de capacidades](mapa-de-capacidades.md). Estado: **decidida** em 26/10/2026
> pelas sugestões (o dono pediu para as fases seguirem sem parar para aprovação).
> Depende de [`clientes`](SPEC-clientes.md), [`acervo`](SPEC-acervo.md) e [`equipe`](SPEC-equipe.md).
> Aposenta o `formulario.emmovimento.tech` (as perguntas são as mesmas — mapa › apêndice B).

## Objetivo

O cliente preenche o formulário de acesso **dentro da central**, por um link só dele que vale
72 horas; as respostas caem direto na ficha, as **senhas vão para um cofre cifrado** que só
quem tem permissão abre (e cada abertura fica registrada), e a agência gera o **relatório de
acessos** em PDF para devolver ao cliente.

### Histórias

- Como **dono**, na ficha da Turbo Kids clico "Gerar link do formulário" e mando pelo
  WhatsApp da agência; o cliente preenche no celular, salva e volta depois, e envia.
- Como **dono**, vejo as respostas na ficha, e o Instagram, o Facebook, o Google e o TikTok
  já estão no cofre; clico "Ver senha" e o sistema registra que eu vi.
- Como **social media** sem a permissão do cofre, vejo que existe o acesso do Instagram e o
  login, mas não a senha.
- Como **dono**, gero o relatório de acessos para entregar ao cliente organizado.

## Decisões

| # | Decisão | Por quê |
|---|---|---|
| F1 | **As mesmas perguntas** do formulário atual (apêndice B), com o mesmo aviso de "só contas corporativas" e várias empresas do mesmo grupo. | Os clientes já conhecem; nada a reaprender. |
| F2 | Link `/agencia/formulario/<token>` com token de 43 caracteres guardado **só em hash**; vale **72 h**; gerar um novo cancela o anterior. | Mesmo desenho do convite (Fase 1). |
| F3 | **Rascunho** salvo a cada etapa, **sem as senhas**: senha só é gravada no envio final, e cifrada. O cliente vê "as senhas são guardadas quando você enviar". | Rascunho não pode virar lugar de senha em claro. |
| F4 | No envio: respostas na ficha (campos vazios do cadastro são preenchidos; as empresas entram se o cadastro não tem nenhuma); senhas no **cofre**; uma **cópia legível sem senhas** vai para a subpasta "01 Formulário" do Drive (D20), se o Drive estiver conectado; aviso geral "formulário preenchido". | D8, D20. |
| F5 | **Cofre**: AES-256-GCM (`lib/crypto/aes_gcm.ts`), senha nunca em log, aviso, WhatsApp ou Drive. Login (usuário, e-mail, página) fica visível para quem alcança o cliente; a **senha** só com `cofre.ver_senhas`, e cada vez que alguém vê ou gera o relatório fica uma linha em `agencia_cofre_visualizacoes` e na auditoria. | D8, mapa › Limites. |
| F6 | A agência também cadastra e edita acessos à mão no cofre (`cofre.ver_senhas`). | Acesso que chega por outro caminho. |
| F7 | **Relatório de acessos** em PDF, gerado na hora (nunca salvo em disco ou no Drive), com plataforma, login e senha, e a data. | D20: "um botão gera o relatório de acessos". |
| F8 | **Arquivos** do formulário (identidade visual, fotos e gravações) vão direto do navegador do cliente para a pasta dele no Drive (subpastas 04 e 05), pela mesma sessão resumível da Fase 2; sem Drive conectado, o formulário diz que a agência vai pedir os arquivos depois. | Arquivo pesado mora no Drive (D20). |
| F9 | Link enviado pelo **WhatsApp da agência** ao responsável do cadastro (motivo novo `formulario`), dentro da janela de horário. | O cliente vive no WhatsApp. |
| F10 | A rota pública tem **limite de tentativas** por endereço e por link. | DoD 6 (rota pública com rate limit). |

## Dados (migration 9007)

`agencia_formularios` (cliente, hash do token, expira em, situação aberto/enviado/cancelado,
rascunho e respostas em jsonb SEM senhas, enviado em), `agencia_cofre_itens` (cliente,
plataforma, rótulo, login, extra, senha cifrada — ct/iv/tag —, origem formulário/manual) e
`agencia_cofre_visualizacoes` (item, quem, quando, motivo ver/relatório). Mesmo regime das
outras fases. `agencia_envios_whatsapp.motivo` ganha `formulario`.

## Telas

| Onde | O quê |
|---|---|
| Ficha do cliente › **Acessos** | Formulário: gerar link, copiar, mandar no WhatsApp, situação (aberto até…, enviado em…), respostas. Cofre: lista por plataforma com login, "Ver senha" (registra), "Copiar", editar, adicionar, quem viu por último; "Relatório de acessos (PDF)". |
| `/agencia/formulario/<token>` | Público, no celular: as perguntas em etapas, rascunho, envio de arquivos, tela de "recebido". |

## Critérios de aceite

1. Link gerado vale 72 h; vencido, cancelado ou já enviado mostra a frase certa.
2. O rascunho volta ao reabrir o link e nunca contém senha.
3. Enviar grava as respostas, preenche o cadastro vazio, põe as senhas no cofre cifradas.
4. Sem `cofre.ver_senhas`, a senha não chega à tela (recusa no servidor); com ela, cada ver
   fica registrado.
5. O relatório PDF sai com os acessos e registra quem gerou.
6. Nenhuma senha em log, aviso, WhatsApp, banco em claro ou Drive.
7. Rota pública com limite de tentativas.
