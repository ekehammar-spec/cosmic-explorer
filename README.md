# Cosmic Explorer

En ny bild från universum varje dag, med trivia och förklaringar på tre nivåer.

## Så fungerar det

- `index.html` är hela sajten. Den innehåller inga nycklar och läser bara färdiga filer i `data/`.
- `scripts/generate.mjs` körs varje morgon av GitHub. Det läser NASA:s bildflöde, låter Gemini skriva trivia och texter, och sparar en fil per dag i `data/`.
- `.github/workflows/daily.yml` är schemat för jobbet.

## Kom igång

1. Skapa ett nytt **publikt** repo på GitHub och ladda upp alla filer i den här mappen (även den dolda mappen `.github`).
2. Skaffa en gratis Gemini-nyckel: https://aistudio.google.com/apikey
3. I repot: **Settings → Secrets and variables → Actions → New repository secret**. Lägg in
   `GEMINI_API_KEY`. Där är den dold för alla.
4. **Settings → Pages**: välj *Deploy from a branch*, gren `main`, mapp `/ (root)`.
5. **Actions → Dagens bild → Run workflow** för att köra jobbet första gången.

Sajten hamnar på `https://<ditt-användarnamn>.github.io/<repots-namn>/`.

## Inställningar

Valfria värden i `daily.yml` under `env`:

- `GEMINI_MODEL`: vilken Gemini-modell som används (standard `gemini-3.5-flash-lite`).

NASA:s bildflöde kräver ingen nyckel. En NASA-nyckel behövs först när asteroiddelen byggs.
