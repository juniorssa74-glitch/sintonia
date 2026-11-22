# Sintonia

App de música com acompanhamento diário de streams no Spotify, por artista, álbum e música (diário, semanal e mensal).

- **Site (online):** `https://<seu-usuario>.github.io/<repositorio>/`
- **APK Android:** Releases → `apk` → `Sintonia.apk`

## Como funciona

| Parte | Onde |
|---|---|
| Coleta a cada 3h no kworb.net, histórico em `data/history/` | `.github/workflows/update.yml` + `scripts/collect.js` + `lib/tracker.js` |
| Site estático (lê `site/data/*.json`) | `site/` → GitHub Pages |
| APK (abre o site; atualiza sozinho) | `.github/workflows/apk.yml` + `android-shell/` |

**Adicionar/remover artista:** no app, toque em *Acompanhar* / *Deixar de acompanhar*. Abre uma issue no GitHub; ao enviá-la, a coleta roda e fecha a issue. Só issues abertas pelo dono do repositório são aceitas.

**Semanal/mensal:** soma dos dias coletados (ou diferença de totais quando há histórico). Ficam completos após 7 e 30 dias de coleta.

## Configuração (uma vez)

1. Settings → Pages → *Build and deployment* → Source: **GitHub Actions**.
2. Actions → *Coletar streams e publicar* → **Run workflow**.
3. Actions → *Gerar APK* → **Run workflow**. O APK aparece em Releases → `apk`.

## Testar no computador

```
node scripts/collect.js   # coleta e gera site/data
node server.js            # http://localhost:5173
```

Fonte dos streams: [kworb.net](https://kworb.net) (permite acesso automatizado). O Chartmasters proíbe coleta automática da ferramenta de streams no robots.txt, então o app só tem um link para lá.
