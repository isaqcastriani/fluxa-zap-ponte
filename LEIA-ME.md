# Ponte WhatsApp por QR code

Programa pequeno que segura a conexão do WhatsApp (igual ao WhatsApp Web) e liga o seu número ao Fluxa CRM. Sem fornecedor no meio, sem custo por mensagem. Usa a biblioteca aberta Baileys.

> **Conexão não oficial.** Não é a API da Meta. O WhatsApp pode bloquear o número, mesmo com uso cuidadoso. Use um número dedicado e nunca dispare em massa.

## Por que existe uma ponte

O CRM publicado fica na Cloudflare, que não mantém conexão aberta o tempo todo. O WhatsApp por QR precisa disso. Então a conexão mora num programa à parte, numa máquina que fica ligada: um computador do escritório ou um servidor.

**É a ponte que procura o CRM.** A cada poucos segundos ela chama o CRM, entrega o que chegou, conta o que enviou e leva a próxima mensagem. Por isso:

- funciona com o CRM na internet e a ponte atrás de qualquer roteador;
- não precisa abrir porta, nem túnel, nem endereço fixo;
- ninguém digita senha: o endereço de pareamento que o CRM gera já é a credencial.

## Ligar

1. No CRM: **Canais**, **WhatsApp por QR code**, Criar canal. A aba Conexão mostra uma linha de comando.
2. Na máquina que vai ficar ligada, dentro da pasta `zap`:

```bash
npm install          # só na primeira vez
npm start -- "https://SEU-CRM/hooks/zap/chan_...?k=zap_..."     # a linha que o CRM mostrou
```

3. O QR code aparece sozinho no CRM. No celular: WhatsApp, Dispositivos conectados, Conectar dispositivo.

Da segunda vez em diante basta `npm start`: o endereço fica guardado em `zap/dados/pareamento.txt` e a sessão em `zap/dados/sessao/`. Reiniciar não pede QR de novo.

Para subir junto com o Windows, crie uma tarefa no Agendador que rode `node C:\caminho\zap\ponte.mjs` ao iniciar sessão. Para outra máquina, copie a pasta `zap` (sem `node_modules` e sem `dados`).

## O que acontece quando algo para

| Situação | O que acontece |
|---|---|
| Ponte desligada | Nada entra nem sai. O que estava na fila do CRM espera e sai quando ela voltar. O canal aparece como "ponte desligada" depois de 30 segundos |
| Internet caiu | A ponte guarda o que chegou em `dados/recebidas.json` e entrega quando voltar |
| Celular desconectou a sessão | A ponte apaga a sessão e o CRM mostra um QR novo |
| Ponte caiu no meio de um envio | A mensagem fica "incerta" no CRM e ninguém reenvia sozinho: uma pessoa decide na conversa |
| Canal desligado no CRM | A ponte recebe o aviso, sai do WhatsApp, apaga o pareamento e encerra |
| Endereço de pareamento vazou | Em Canais, "Gerar endereço novo". O antigo para de valer |

## Limites que o CRM impõe neste canal

- Só texto. Botões viram menu numerado. Foto, áudio e documento aparecem como "mídia recebida, abra no celular".
- Grupos, status e canais do WhatsApp são ignorados.
- **Transmissão bloqueada**, sem contorno.
- No máximo 4 mensagens seguidas do bot sem resposta do cliente e 6 segundos entre envios.
- Uma mensagem nunca sai duas vezes: a ponte lembra o que já enviou e o CRM confere antes de oferecer de novo.

## Custo

A ponte não custa nada. O que pesa é o plano gratuito da Cloudflare: a ponte chama o CRM a cada 6 segundos parada e a cada 1,5 segundo com conversa rolando. Parada, são cerca de 14 mil chamadas por dia, dentro das 100 mil do plano gratuito, mas somando com o resto do uso. Se apertar, o plano pago (US$ 5 por mês) resolve.

## Referência

Variáveis: `ZAP_CRM` (endereço de pareamento, no lugar do argumento), `ZAP_DATA` (pasta dos dados), `ZAP_MIN_INTERVAL_MS` (3000), `ZAP_LOG` (silent).

Protocolo: `POST <pareamento>/sync` com `Authorization: Bearer <k>` e corpo `{state, qr, me, last_error, inbound[], results[]}`. Resposta: `{inbound_ack[], results_ack[], outbound[{id,to,text}], next_ms, command?}`. Código do lado do CRM em `src/worker/channels/zapSync.ts`.

Modo simulado: `npm run mock -- "<pareamento>"` sobe a ponte sem WhatsApp, com controle em `http://127.0.0.1:8796/__mock/*` (`scan`, `drop`, `qr`, `inbound`, `sent`, `fail`, `state`). É o que `test/e2e/zap.mjs` usa.

## O que foi provado e o que não foi (09/11/2026)

- Provado: a biblioteca conecta no WhatsApp e gera QR válido nesta máquina, e o QR desenhado pelo CRM foi lido por um leitor de QR no tamanho real do código. O canal passa no teste de ponta a ponta com a ponte simulada (pareamento, receber, responder, intervalo, dono respondendo pelo celular, conta com identificador oculto, falhas, ponte desligada e de volta, queda do WhatsApp, desligar).
- **Não provado: enviar e receber com um número real**, porque exige alguém escanear o QR com um celular.
- **Não provado: a ponte falando com o CRM publicado**, porque o CRM ainda não foi publicado.
