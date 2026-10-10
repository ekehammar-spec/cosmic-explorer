// Morgonjobbet: läser NASA:s APOD-flöde, låter Gemini skriva trivia och
// nivåtexter på svenska, och sparar allt som färdiga filer i data/.
// Sajten läser bara de filerna, så inga nycklar hamnar någonsin hos besökaren.
//
// Källan är NASA:s RSS-flöde (kräver ingen nyckel). Det gamla APOD-API:et
// lämnar sedan NASA flyttade sajten ut felaktiga svar och används därför inte.
//
// Körs av GitHub Actions (se .github/workflows/daily.yml). Lokalt:
//   GEMINI_API_KEY=... node scripts/generate.mjs

import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const FEED = process.env.APOD_FEED || "https://science.nasa.gov/feed/apod-basic/";
const GEMINI_KEY = process.env.GEMINI_API_KEY;
// Modeller i turordning: den starkaste först. En modell som nekas (t.ex. för att
// den inte ingår i gratisnivån) hoppas över resten av körningen.
const MODELS = (process.env.GEMINI_MODEL || "gemini-3.8-flash,gemini-3.5-flash-lite").split(",").map(m => m.trim()).filter(Boolean);
const VERSION = 3; // höj för att låta jobbet skriva om befintliga dagar

if (!GEMINI_KEY) {
  console.error("GEMINI_API_KEY saknas.");
  process.exit(1);
}

const fileFor = date => path.join(DATA, date + ".json");

/* ---------- NASA:s flöde ---------- */
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = s => s
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&(\w+);/g, (m, n) => ENT[n] ?? m);
const raw = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  if (!m) return "";
  return m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1").trim();
};
const text = (xml, name) => decode(decode(raw(xml, name)).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

function sized(url, size) {
  // NASA:s bildtjänst kan leverera valfri storlek via ?w=&h=
  if (!/assets\.science\.nasa\.gov\/dynamicimage\//.test(url)) return url;
  return url.split("?")[0] + `?w=${size}&h=${size}&fit=clip`;
}

async function fetchFeed() {
  const res = await fetch(FEED, { headers: { "user-agent": "cosmic-explorer (github actions)" } });
  if (!res.ok) throw new Error(`NASA:s flöde svarade ${res.status}`);
  const xml = await res.text();
  const items = [];
  for (const part of xml.split(/<item[\s>]/).slice(1)) {
    const item = part.split("</item>")[0];
    const published = new Date(text(item, "pubDate"));
    const image = decode(raw(item, "apod:hdurl"));
    if (isNaN(published) || !/^https:\/\/\S+\.(jpe?g|png|webp|gif)(\?|$)/i.test(image)) continue; // t.ex. videodagar
    const q = new URL(image).searchParams;
    items.push({
      date: published.toISOString().slice(0, 10),
      title: text(item, "title"),
      explanation: text(item, "apod:explanation").replace(/^Explanation:\s*/i, ""),
      credit: text(item, "apod:credit").replace(/^\s*(image\s+)?credits?\s*(&|and)?\s*(copyright)?\s*:\s*/i, "").replace(/\s+([,.;])/g, "$1").slice(0, 200),
      link: decode(raw(item, "link")),
      url: sized(image, 1600),
      thumb: sized(image, 480),
      hdurl: image,
      w: Number(q.get("w")) || undefined,
      h: Number(q.get("h")) || undefined
    });
  }
  return items.filter(i => i.title && i.explanation.length > 80);
}

/* ---------- Gemini ---------- */
const SCHEMA = {
  type: "OBJECT",
  required: ["title_sv", "quiz", "levels", "terms"],
  properties: {
    title_sv: { type: "STRING" },
    quiz: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        required: ["q", "options", "correct", "fact"],
        properties: {
          q: { type: "STRING" },
          options: { type: "ARRAY", items: { type: "STRING" } },
          correct: { type: "INTEGER" },
          fact: { type: "STRING" }
        }
      }
    },
    levels: {
      type: "OBJECT",
      required: ["barn", "nyborjare", "entusiast"],
      properties: { barn: { type: "STRING" }, nyborjare: { type: "STRING" }, entusiast: { type: "STRING" } }
    },
    terms: {
      type: "ARRAY",
      items: { type: "OBJECT", required: ["term", "explanation"], properties: { term: { type: "STRING" }, explanation: { type: "STRING" } } }
    }
  }
};

function promptFor(apod) {
  return `Du är en svensk vetenskapsjournalist som skriver innehåll till en rymdapp. Underlaget är NASA:s "Astronomy Picture of the Day".

Titel: ${apod.title}
NASA:s beskrivning: ${apod.explanation}

Skriv:
1. title_sv: bildens titel på naturlig svenska. Använd vedertagna svenska namn (t.ex. Vintergatan, Andromedagalaxen, Orionnebulosan). Behåll katalogbeteckningar som M83 och NGC 1234. Översätt eller behåll engelska egennamn, men blanda aldrig engelska ord med svensk böjning.
2. quiz: exakt 3 roliga och lärorika flervalsfrågor.
   - Varje fråga ska lära ut astronomi, fysik eller rymdfart: vad objektet är, hur det fungerar, hur stort eller avlägset det är, hur det bildades.
   - Fråga aldrig om hur fotot togs eller planerades, vem fotografen är, eller detaljer som bara går att veta om man läst NASA:s text.
   - Spelaren ser bilden men varken titeln eller NASA:s text. Frågorna ska gå att resonera sig fram till, och får inte avslöja varandras svar.
   - Varje fråga har exakt 3 alternativ i "options". Alla tre ska vara rimliga, ungefär lika långa och skrivna i samma stil.
   - "correct" är index (0, 1 eller 2) för rätt alternativ. Variera det mellan frågorna.
   - "fact" är en eller två meningar som förklarar varför svaret är rätt.
3. levels: tre förklaringar av bilden som löpande text utan rubriker och utan markdown, med tom rad mellan stycken.
   - barn: för ett nyfiket barn på 6–9 år. Enkla ord, korta meningar, en lekfull jämförelse från vardagen. Cirka 80 ord.
   - nyborjare: för en vuxen utan förkunskaper. Förklara facktermer första gången de används. Cirka 130 ord.
   - entusiast: för en astronomientusiast. Gå på djupet med fysiken, avstånd, instrument och varför objektet är vetenskapligt intressant. Cirka 220 ord.

4. terms: 4 till 6 facktermer eller egennamn som läsaren kan vilja få förklarade (t.ex. "nebulosa", "ljusår", "Gale-kratern").
   - Varje term måste förekomma ordagrant i minst en av de tre texterna i levels. Skriv den i grundform, precis som stammen står i texten.
   - "explanation" är en enda mening på högst 25 ord som förklarar termen för en nybörjare, utan att upprepa själva termen som förklaring.
   - Välj inte vardagsord som alla förstår.

Ordval: skriv marsrover, rover och rovern (aldrig rovare). Skriv ihop sammansatta ord (trippelpassage, inte trippel passage).

Språk: korrekt, ledig svenska med rätt genus och böjning (en/ett, den/det). Läs igenom varje mening och rätta stavfel innan du svarar. Skriv tal på svenskt vis (1,5 miljoner, 20 000).

Fakta: håll dig strikt till underlaget och väletablerad astronomi. Hitta inte på siffror.`;
}

function valid(c) {
  return c && typeof c.title_sv === "string" &&
    Array.isArray(c.quiz) && c.quiz.length === 3 &&
    c.quiz.every(q => q.q && Array.isArray(q.options) && q.options.length === 3 &&
      Number.isInteger(q.correct) && q.correct >= 0 && q.correct <= 2 && q.fact) &&
    c.levels && ["barn", "nyborjare", "entusiast"].every(k => typeof c.levels[k] === "string" && c.levels[k].length > 40) &&
    Array.isArray(c.terms);
}

const wait = ms => new Promise(r => setTimeout(r, ms));

const dropped = new Set();

async function callGemini(model, apod) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": GEMINI_KEY },
    body: JSON.stringify({
      contents: [{ parts: [{ text: promptFor(apod) }] }],
      generationConfig: { responseMimeType: "application/json", responseSchema: SCHEMA, temperature: 0.6 }
    })
  });
  if (!res.ok) {
    const err = new Error(`${model} svarade ${res.status}: ${(await res.text()).slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const body = await res.json();
  const out = body.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
  const content = JSON.parse(out);
  if (!valid(content)) throw new Error("ofullständigt svar från " + model);
  return content;
}

async function askGemini(apod) {
  let lastError = new Error("Ingen Gemini-modell är tillgänglig");
  for (const model of MODELS) {
    if (dropped.has(model)) continue;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return { content: await callGemini(model, apod), model };
      } catch (e) {
        lastError = e;
        console.warn(`Försök ${attempt} misslyckades: ${e.message}`);
        // 4xx = modellen finns inte, ingår inte i nivån eller kvoten är slut: gå vidare till nästa modell.
        if (e.status >= 400 && e.status < 500 && model !== MODELS[MODELS.length - 1]) {
          dropped.add(model);
          console.warn(`Hoppar över ${model} resten av körningen.`);
          break;
        }
        await wait(Number(process.env.RETRY_MS ?? 8000) * attempt);
      }
    }
  }
  throw lastError;
}

// Liten suddig förhandsbild + bildens mått, så sidan kan visa färgerna direkt
// och aldrig hoppa när den stora bilden kommer. Hoppas över om "sharp" saknas.
async function preview(imageUrl) {
  try {
    const sharp = (await import("sharp")).default;
    const res = await fetch(imageUrl);
    if (!res.ok) throw new Error("bilden svarade " + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    const meta = await sharp(buf).metadata();
    const small = await sharp(buf).resize(32, 32, { fit: "inside" }).jpeg({ quality: 55 }).toBuffer();
    return { w: meta.width, h: meta.height, lqip: "data:image/jpeg;base64," + small.toString("base64") };
  } catch (e) {
    console.warn("Ingen förhandsbild: " + e.message);
    return {};
  }
}

async function needs(date) {
  if (!existsSync(fileFor(date))) return true;
  const old = JSON.parse(await readFile(fileFor(date), "utf8"));
  return Boolean(old.sample) || (old.v || 1) < VERSION; // exempeldagar och äldre versioner skrivs om
}

async function buildDay(apod) {
  const { content, model } = await askGemini(apod);
  const day = {
    v: VERSION,
    model,
    date: apod.date,
    title: apod.title,
    title_sv: content.title_sv,
    media_type: "image",
    url: apod.url,
    thumb: apod.thumb,
    hdurl: apod.hdurl,
    link: apod.link,
    credit: apod.credit || "NASA",
    w: apod.w, h: apod.h,
    ...(await preview(apod.thumb)),
    quiz: content.quiz,
    levels: content.levels,
    terms: content.terms.filter(t => t && t.term && t.explanation).slice(0, 6)
  };
  await writeFile(fileFor(day.date), JSON.stringify(day, null, 2));
  console.log(`Sparade ${day.date}: ${day.title} (${model})`);
}

async function writeIndex() {
  const files = (await readdir(DATA)).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
  const list = [];
  for (const f of files) {
    const d = JSON.parse(await readFile(path.join(DATA, f), "utf8"));
    list.push({ date: d.date, media_type: d.media_type, title: d.title_sv || d.title, thumb: d.thumb || d.url });
  }
  list.sort((a, b) => b.date.localeCompare(a.date));
  await writeFile(path.join(DATA, "index.json"), JSON.stringify(list, null, 1));
}

await mkdir(DATA, { recursive: true });
const items = await fetchFeed();
console.log(`Flödet innehåller ${items.length} bilder.`);
if (!items.length) { console.error("Hittade inga bilder i NASA:s flöde."); process.exit(1); }

let failed = 0;
for (const item of items) {
  if (!(await needs(item.date))) continue;
  try { await buildDay(item); await wait(Number(process.env.PAUSE_MS ?? 13000)); }
  catch (e) { failed++; console.error(`Kunde inte skapa ${item.date}: ${e.message}`); }
}
await writeIndex();
if (failed) process.exit(1);
