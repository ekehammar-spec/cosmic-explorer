// Morgonjobbet: väljer dagens bild bland NASA:s egna bilder, låter Gemini skriva
// trivia och nivåtexter, och sparar allt som färdiga filer i data/.
//
// Dagens bild väljs i den här ordningen, och bara bilder som NASA självt står bakom tas med:
//   1. NASA:s "Astronomy Picture of the Day", de dagar bilden är NASA:s egen
//   2. NASA:s "Image of the Day", när den visar rymden och inte människor eller evenemang
//   3. en bild ur NASA:s bildarkiv som appen inte har visat förut
// Bilder av privata fotografer hoppas över, och sådana som redan sparats byts ut.
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
// Jordbilden: NASA Earth Observatorys "Image of the Day"
const EARTH_FEED = process.env.EARTH_FEED || "https://science.nasa.gov/feed/?science_org=19791%2C22453";
const EARTH = path.join(DATA, "earth");
const EARTH_MAX = Number(process.env.EARTH_MAX ?? 12);   // högst så här många nya jordbilder per körning
const GEMINI_KEY = process.env.GEMINI_API_KEY;
// Modeller i turordning: den starkaste först. En modell som nekas (t.ex. för att
// den inte ingår i gratisnivån) hoppas över resten av körningen.
const MODELS = (process.env.GEMINI_MODEL || "gemini-3.8-flash,gemini-3.5-flash-lite").split(",").map(m => m.trim()).filter(Boolean);
const VERSION = 4; // höj för att låta jobbet skriva om befintliga dagar
const IOTD_FEED = process.env.IOTD_FEED || "https://www.nasa.gov/feeds/iotd-feed/";
const LIBRARY = "https://images-api.nasa.gov";
const DAYS_BACK = Number(process.env.DAYS_BACK ?? 30);   // så här många dagar bakåt ska alltid ha en bild
const FILL_MAX = Number(process.env.FILL_MAX ?? 40);     // högst så här många nya eller utbytta dagar per körning
const SKIP_FILE = path.join(DATA, "skip.json");          // bilder som prövats och valts bort, så de inte prövas igen
const UA = { "user-agent": "cosmic-explorer (github actions)" };

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

const strip = html => decode(decode(html).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

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

/* ---------- Vems är bilden? ---------- */
// Sant bara när NASA (eller ett NASA-center) står som upphov och inget tyder på att någon annan äger rätten.
function nasaOwned(credit) {
  const c = String(credit || "");
  if (!/\b(NASA|JPL|GSFC|STScI|Caltech)\b/i.test(c)) return false;
  return !/©|\(c\)|copyright|\bCC[ -]?BY|creative commons|licen[sc]e|courtesy of (?!NASA)|panorama\s*:|processing\s*(by|:)|processed by/i.test(c);
}
// En sparad dag får ligga kvar om den kommer från en av de nya källorna, eller om dess upphov är NASA:s.
// Bilder som har synats och valts bort för hand (skärmdumpar med anteckningar och liknande).
const REJECT = new Set(["https://www.nasa.gov/image-detail/fd07_impact-flashes/"]);
const MIN_LONG = 1000, MIN_SHORT = 600;   // minsta storlek i bildpunkter för att bilden ska hålla i helskärm
const bigEnough = px => Array.isArray(px) && Math.max(px[0], px[1]) >= MIN_LONG && Math.min(px[0], px[1]) >= MIN_SHORT;
const keepDay = d => Boolean(d && !d.sample && !REJECT.has(d.id) &&
  (((d.src === "iotd" || d.src === "library") && (!d.px || bigEnough(d.px))) || (d.src !== "iotd" && d.src !== "library" && nasaOwned(d.credit))));
async function readDay(date) {
  try { return JSON.parse(await readFile(fileFor(date), "utf8")); } catch (e) { return null; }
}

/* ---------- NASA Image of the Day ---------- */
// Rubriker som nästan alltid betyder människor, evenemang eller teknik på marken.
const NOT_SPACE = /\b(annotations?|screenshots?|sketch(es)?|attends?|visits?|ceremony|sworn|medal|tour|game|grand prix|unveils?|opens?|paint|plaque|patch(es)?|crew (at|visits)|returns? to earth|welcomed|launch(es|ed)?|launch pad|rollout|hangar|engine|tank|wind tunnel|heat test|comes together|install(s|ed|ation)?|processing|training|employees?|team)\b/i;
async function fetchIotd() {
  const res = await fetch(IOTD_FEED, { headers: UA });
  if (!res.ok) throw new Error(`Image of the Day svarade ${res.status}`);
  const xml = await res.text();
  const items = [];
  for (const part of xml.split(/<item[\s>]/).slice(1)) {
    const item = part.split("</item>")[0];
    const published = new Date(text(item, "pubDate"));
    const image = decode((item.match(/<enclosure[^>]*\burl="([^"]+)"/) || [])[1] || "");
    const title = text(item, "title"), explanation = text(item, "description");
    if (isNaN(published) || !/^https:\/\/\S+\.(jpe?g|png|webp)(\?|$)/i.test(image) || explanation.length < 80) continue;
    if (NOT_SPACE.test(title)) continue;
    const link = decode(raw(item, "link"));
    const by = (explanation.match(/(?:image|photo) credit:?\s*\(?([^)]{3,120})\)?\s*$/i) || [])[1];
    items.push({ src: "iotd", id: link || image, date: published.toISOString().slice(0, 10), title, explanation, credit: by || "NASA", link, url: image + "?w=1600", thumb: image + "?w=480", hdurl: image });
  }
  return items;
}

/* ---------- NASA:s bildarkiv ---------- */
// Ämnen som jobbet går runt bland, ett per dag, så att bilderna varierar.
const TOPICS = ["hubble nebula", "saturn cassini", "galaxy hubble", "mars surface", "jupiter", "supernova remnant", "moon lunar reconnaissance orbiter",
  "star cluster hubble", "sun solar dynamics observatory", "spitzer nebula", "pluto new horizons", "chandra galaxy", "titan cassini", "comet",
  "webb telescope", "mercury messenger", "neptune voyager", "europa", "enceladus", "galaxy cluster", "planetary nebula", "star forming region"];
const CENTERS = ["JPL", "GSFC", "STScI"];   // forskningscentren. Huvudkontorets bilder är mest människor och evenemang.
const NOT_PHOTO = /illustration|artist|concept|rendering|diagram|graphic|infographic|logo|poster|animation|chart|schematic|spectrum|spectra|\bplot\b|\bgraph\b|simulation|model of|engineers?|technicians?|clean ?room|\bteam\b|launch|rollout|testing|assembly|spacecraft (is|was|being)|press conference|briefing/i;
async function libraryCandidates(topic, center, page) {
  const url = `${LIBRARY}/search?q=${encodeURIComponent(topic)}&media_type=image&center=${center}&page_size=60&page=${page}`;
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`bildarkivet svarade ${res.status}`);
  const body = await res.json();
  return (body.collection?.items || []).map(it => it.data?.[0]).filter(Boolean).map(d => ({
    src: "library", id: d.nasa_id, title: String(d.title || "").trim(), explanation: strip(String(d.description || "")),
    credit: String(d.secondary_creator || d.photographer || "").trim() || "NASA/" + (d.center || center),
    link: "https://images.nasa.gov/details/" + encodeURIComponent(d.nasa_id)
  })).filter(c => c.id && c.title && c.explanation.length > 200 && nasaOwned(c.credit) && !NOT_PHOTO.test(c.title + " " + c.explanation.slice(0, 400)));
}
// Arkivet har inte alla storlekar av varje bild, så vi frågar vilka som finns.
async function libraryAsset(c) {
  const res = await fetch(`${LIBRARY}/asset/${encodeURIComponent(c.id)}`, { headers: UA });
  if (!res.ok) throw new Error(`bildens filer svarade ${res.status}`);
  const files = ((await res.json()).collection?.items || []).map(i => String(i.href || "").replace(/^http:/, "https:")).filter(h => /\.(jpe?g|png)$/i.test(h));
  const pick = (...sizes) => { for (const s of sizes) { const f = files.find(h => h.includes("~" + s + ".")); if (f) return f; } };
  const url = pick("large", "medium", "orig"), thumb = pick("small", "medium", "thumb") || url, hdurl = pick("orig", "large") || url;
  if (!url) throw new Error("ingen användbar bildfil");
  return { ...c, url: encodeURI(url), thumb: encodeURI(thumb), hdurl: encodeURI(hdurl) };
}

/* ---------- Gemini ---------- */
const QUIZ = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    required: ["q", "options", "correct", "fact"],
    properties: { q: { type: "STRING" }, options: { type: "ARRAY", items: { type: "STRING" } }, correct: { type: "INTEGER" }, fact: { type: "STRING" } }
  }
};
const LEVELS = {
  type: "OBJECT",
  required: ["barn", "nyborjare", "entusiast"],
  properties: { barn: { type: "STRING" }, nyborjare: { type: "STRING" }, entusiast: { type: "STRING" } }
};
const TERMS = {
  type: "ARRAY",
  items: { type: "OBJECT", required: ["term", "explanation"], properties: { term: { type: "STRING" }, explanation: { type: "STRING" } } }
};
const SCHEMA = {
  type: "OBJECT",
  required: ["fits", "title_sv", "quiz", "levels", "terms", "en"],
  properties: {
    fits: { type: "BOOLEAN" },
    title_sv: { type: "STRING" },
    quiz: QUIZ,
    levels: LEVELS,
    terms: TERMS,
    en: {
      type: "OBJECT",
      required: ["quiz", "levels", "terms"],
      properties: { quiz: QUIZ, levels: LEVELS, terms: TERMS }
    }
  }
};
const EARTH_SCHEMA = {
  type: "OBJECT",
  required: ["title_sv", "place_sv", "levels", "terms", "en"],
  properties: {
    title_sv: { type: "STRING" },
    place_sv: { type: "STRING" },
    levels: LEVELS,
    terms: TERMS,
    en: { type: "OBJECT", required: ["place", "levels", "terms"], properties: { place: { type: "STRING" }, levels: LEVELS, terms: TERMS } }
  }
};

function promptFor(apod) {
  return `Du är en svensk vetenskapsjournalist som skriver innehåll till en rymdapp. Underlaget är en bild från NASA med NASA:s egen beskrivning.

Titel: ${apod.title}
NASA:s beskrivning: ${apod.explanation.slice(0, 6000)}

Skriv:
0. fits: true om själva bilden visar rymden, ett himlakroppsobjekt, en planets eller månes yta, eller jorden sedd från rymden. false om bilden främst visar människor, ett evenemang, byggnader, utrustning eller raketer på marken, eller om den är en illustration, ett diagram eller en konstnärs tolkning.
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

5. en: samma innehåll på engelska, skrivet direkt på naturlig engelska och inte ordagrant översatt.
   - en.quiz: samma tre frågor med samma rätta svar på samma plats.
   - en.levels: samma tre nivåer (nycklarna heter fortfarande barn, nyborjare och entusiast).
   - en.terms: 4 till 6 termer som förekommer ordagrant i de engelska texterna, med förklaring på engelska.

Fakta: håll dig strikt till underlaget och väletablerad astronomi. Hitta inte på siffror.`;
}

function promptEarth(e) {
  return `Du är en svensk vetenskapsjournalist som skriver till en app om rymden och jorden. Underlaget är en satellitbild från NASA Earth Observatory med tillhörande artikel.

Titel: ${e.title}
Ämnen: ${e.topics}
Artikel: ${e.article}

Läsaren ska betrakta bilden och förstå vad den visar. Det finns inga frågor och inga poäng.

Skriv:
1. title_sv: titeln på naturlig svenska. Behåll ortnamn i sin svenska form när en sådan finns.
2. place_sv: var på jorden bilden är tagen, kort (t.ex. "Thailand", "Texas, USA", "Arktis").
3. levels: tre förklaringar som löpande text utan rubriker och utan markdown, med tom rad mellan stycken. Börja med vad man faktiskt ser i bilden: färger, former och vad de betyder.
   - barn: för ett nyfiket barn på 6–9 år. Enkla ord och korta meningar. Var varsam om bilden visar en katastrof: berätta sakligt och utan att skrämmas. Cirka 80 ord.
   - nyborjare: för en vuxen utan förkunskaper. Förklara facktermer första gången de används. Cirka 130 ord.
   - entusiast: för den som vill veta mer om satelliten, instrumentet, våglängderna och vad forskarna lär sig. Cirka 220 ord.
4. terms: 4 till 6 facktermer eller egennamn som förekommer ordagrant i texterna, i grundform, var och en med en förklaring på en mening om högst 25 ord. Välj inte vardagsord.
5. en: samma innehåll skrivet direkt på naturlig engelska: en.place, en.levels (samma tre nycklar) och en.terms (termer ur de engelska texterna).

Ton: lugn, saklig och respektfull. Om bilden visar en översvämning, brand eller torka som drabbar människor: beskriv det med medkänsla och utan sensationslystnad.

Språk: korrekt, ledig svenska med rätt genus och böjning. Skriv ihop sammansatta ord. Läs igenom och rätta stavfel innan du svarar. Skriv tal på svenskt vis (1,5 miljoner, 20 000).

Fakta: håll dig strikt till artikeln. Hitta inte på siffror, orsaker eller följder som inte står där.`;
}

function valid(c) {
  return c && typeof c.title_sv === "string" &&
    Array.isArray(c.quiz) && c.quiz.length === 3 &&
    c.quiz.every(q => q.q && Array.isArray(q.options) && q.options.length === 3 &&
      Number.isInteger(q.correct) && q.correct >= 0 && q.correct <= 2 && q.fact) &&
    c.levels && ["barn", "nyborjare", "entusiast"].every(k => typeof c.levels[k] === "string" && c.levels[k].length > 40) &&
    Array.isArray(c.terms);
}
const okLevels = l => l && ["barn", "nyborjare", "entusiast"].every(k => typeof l[k] === "string" && l[k].length > 40);
function validEarth(c) {
  return c && typeof c.title_sv === "string" && c.title_sv && okLevels(c.levels) && Array.isArray(c.terms);
}
const cleanTerms = t => (Array.isArray(t) ? t : []).filter(x => x && x.term && x.explanation).slice(0, 6);
// Den engelska delen sparas om den är hel. En trasig engelsk del ska inte stoppa den svenska.
function english(c, withQuiz) {
  const en = c.en;
  if (!en || !okLevels(en.levels)) return undefined;
  const out = { levels: en.levels, terms: cleanTerms(en.terms) };
  if (en.place) out.place = en.place;
  if (withQuiz) {
    const ok = Array.isArray(en.quiz) && en.quiz.length === 3 && en.quiz.every(q => q.q && Array.isArray(q.options) && q.options.length === 3 && q.fact);
    if (!ok) return undefined;
    out.quiz = en.quiz.map((q, i) => ({ ...q, correct: c.quiz[i].correct }));
  }
  return out;
}

const wait = ms => new Promise(r => setTimeout(r, ms));

const dropped = new Set();

async function callGemini(model, prompt, schema, check) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": GEMINI_KEY },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: 0.6 }
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
  if (!check(content)) throw new Error("ofullständigt svar från " + model);
  return content;
}

async function askGemini(prompt, schema = SCHEMA, check = valid) {
  let lastError = new Error("Ingen Gemini-modell är tillgänglig");
  for (const model of MODELS) {
    if (dropped.has(model)) continue;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return { content: await callGemini(model, prompt, schema, check), model };
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

// Den stora bildens verkliga mått, så att för små bilder kan väljas bort.
async function measure(imageUrl) {
  const sharp = (await import("sharp")).default;
  const res = await fetch(imageUrl, { headers: UA });
  if (!res.ok) throw new Error("bilden svarade " + res.status);
  const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
  return [meta.width, meta.height];
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

async function buildDay(apod, mustFit = false) {
  const { content, model } = await askGemini(promptFor(apod));
  if (mustFit && content.fits === false) { const e = new Error("bilden visar inte rymden"); e.unfit = true; throw e; }
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
    src: apod.src || "apod", id: apod.id, px: apod.px,
    w: apod.w, h: apod.h, lqip: apod.lqip,
    ...(apod.lqip ? {} : await preview(apod.thumb)),
    quiz: content.quiz,
    levels: content.levels,
    terms: cleanTerms(content.terms),
    en: english(content, true)
  };
  await writeFile(fileFor(day.date), JSON.stringify(day, null, 2));
  console.log(`Sparade ${day.date}: ${day.title} (${model}, källa: ${day.src})`);
}

async function writeIndex() {
  const files = (await readdir(DATA)).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
  const list = [];
  for (const f of files) {
    const d = JSON.parse(await readFile(path.join(DATA, f), "utf8"));
    if (!keepDay(d)) continue;   // privata fotografers bilder som inte hunnit bytas ut visas inte
    list.push({ date: d.date, media_type: d.media_type, title: d.title_sv || d.title, thumb: d.thumb || d.url });
  }
  list.sort((a, b) => b.date.localeCompare(a.date));
  await writeFile(path.join(DATA, "index.json"), JSON.stringify(list, null, 1));
}

/* ---------- Jordbilden ---------- */
async function fetchEarth() {
  const res = await fetch(EARTH_FEED, { headers: { "user-agent": "cosmic-explorer (github actions)" } });
  if (!res.ok) throw new Error(`Jordflödet svarade ${res.status}`);
  const xml = await res.text();
  const items = [];
  for (const part of xml.split(/<item[\s>]/).slice(1)) {
    const item = part.split("</item>")[0];
    const published = new Date(text(item, "pubDate"));
    const body = raw(item, "content:encoded");
    const cats = [...item.matchAll(/<category>([\s\S]*?)<\/category>/g)].map(m => strip(m[1].replace(/<!\[CDATA\[|\]\]>/g, "")));
    if (isNaN(published) || !cats.includes("Earth Observatory")) continue;
    const img = (body.match(/https:\/\/assets\.science\.nasa\.gov\/dynamicimage\/[^"'\s?]*\/eo\/[^"'\s?]+\.(?:jpe?g|png)/i) || [])[0];
    const credit = strip((body.match(/class="hds-credits"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || "");
    const source = ((strip(body).match(/NASA Earth Observatory (?:images?|photos?|maps?|animations?|videos?) (?:by|courtesy).{0,240}?(?=\s*Story by|\s*Text by|$)/) || [])[0] || "").trim();
    const paragraphs = [...body.matchAll(/<p class="wp-block-paragraph"[^>]*>([\s\S]*?)<\/p>/g)].map(m => strip(m[1])).filter(t => t.length > 40);
    const article = (paragraphs.join("\n\n") || text(item, "description")).replace(/The post .* appeared first on NASA Science\./, "").slice(0, 6000);
    const rights = credit + " " + source;
    // Bara NASA:s egna bilder tas med. Andras bilder är märkta med ägarens namn och hoppas över.
    if (!img || !/NASA/i.test(rights) || /©|copyright|Planet Labs|Maxar|Airbus|courtesy of (?!NASA)/i.test(rights)) {
      console.log(`Jordbild hoppas över (${text(item, "title")}): ${img ? "upphov: " + (rights.trim() || "saknas") : "ingen bild"}`);
      continue;
    }
    items.push({
      date: published.toISOString().slice(0, 10), title: text(item, "title"), link: decode(raw(item, "link")),
      topics: cats.filter(c => c !== "Earth Observatory").join(", "), article, credit, source,
      url: sized(img, 1600), thumb: sized(img, 480), hdurl: img
    });
  }
  return items.filter(i => i.title && i.article.length > 60);
}
const earthFile = date => path.join(EARTH, date + ".json");
async function buildEarth(e) {
  const { content, model } = await askGemini(promptEarth(e), EARTH_SCHEMA, validEarth);
  const day = {
    v: VERSION, model, date: e.date, title: e.title, title_sv: content.title_sv, place: content.place_sv || "",
    url: e.url, thumb: e.thumb, hdurl: e.hdurl, link: e.link, credit: e.credit || "NASA Earth Observatory", source: e.source,
    ...(await preview(e.thumb)),
    levels: content.levels, terms: cleanTerms(content.terms), en: english(content, false)
  };
  await writeFile(earthFile(day.date), JSON.stringify(day, null, 2));
  console.log(`Sparade jordbild ${day.date}: ${day.title} (${model})`);
}
async function writeEarthIndex() {
  const files = (await readdir(EARTH)).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
  const list = [];
  for (const f of files) {
    const d = JSON.parse(await readFile(path.join(EARTH, f), "utf8"));
    list.push({ date: d.date, title: d.title_sv || d.title, place: d.place, thumb: d.thumb || d.url });
  }
  list.sort((a, b) => b.date.localeCompare(a.date));
  await writeFile(path.join(EARTH, "index.json"), JSON.stringify(list, null, 1));
}

await mkdir(DATA, { recursive: true });
await mkdir(EARTH, { recursive: true });
let failed = 0;
const pause = () => wait(Number(process.env.PAUSE_MS ?? 13000));

// 1. Astronomy Picture of the Day, bara de dagar bilden är NASA:s egen.
let items = [];
try { items = await fetchFeed(); console.log(`Flödet innehåller ${items.length} bilder.`); }
catch (e) { console.error("APOD-flödet hoppades över: " + e.message); }
for (const item of items) {
  if (!nasaOwned(item.credit)) { console.log(`APOD ${item.date} hoppas över, upphov: ${item.credit || "saknas"}`); continue; }
  if (!(await needs(item.date))) continue;
  try { await buildDay({ ...item, src: "apod", id: item.link }); await pause(); }
  catch (e) { failed++; console.error(`Kunde inte skapa ${item.date}: ${e.message}`); }
}

// 2 och 3. Fyll de dagar som saknar bild, eller som har en privat fotografs bild, med NASA:s egna.
try {
  const skip = new Set(existsSync(SKIP_FILE) ? JSON.parse(await readFile(SKIP_FILE, "utf8")) : []);
  const used = new Set();
  for (const f of (await readdir(DATA)).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))) {
    const d = JSON.parse(await readFile(path.join(DATA, f), "utf8"));
    if (keepDay(d) && d.id) used.add(d.id);
  }
  for (const f of (await readdir(DATA)).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))) {
    const file = path.join(DATA, f), d = JSON.parse(await readFile(file, "utf8"));
    if ((d.src !== "iotd" && d.src !== "library") || d.px) continue;
    try {
      d.px = await measure(d.url);
      await writeFile(file, JSON.stringify(d, null, 2));
      if (!bigEnough(d.px)) { console.log(`${d.date}: ${d.title} är för liten (${d.px[0]}×${d.px[1]}) och byts ut.`); skip.add(d.id); used.delete(d.id); }
    } catch (e) { console.warn(`${d.date}: kunde inte mäta bilden (${e.message})`); }
  }
  for (const id of REJECT) skip.add(id);
  let iotd = [];
  try { iotd = await fetchIotd(); console.log(`Image of the Day: ${iotd.length} möjliga bilder.`); }
  catch (e) { console.error("Image of the Day hoppades över: " + e.message); }

  const dayMs = 864e5, today = new Date().toISOString().slice(0, 10);
  const dates = Array.from({ length: DAYS_BACK }, (_, i) => new Date(Date.parse(today) - i * dayMs).toISOString().slice(0, 10));
  const free = c => !used.has(c.id) && !skip.has(c.id);
  // Prövar en kandidat: bilden måste gå att hämta och vara stor nog, och Gemini måste hålla med om att den visar rymden.
  async function tryCandidate(date, cand) {
    const c = cand.src === "library" ? await libraryAsset(cand) : cand;
    const p = await preview(c.thumb);
    if (!p.w) throw new Error("bilden gick inte att hämta");
    const px = await measure(c.url);
    if (!bigEnough(px)) throw Object.assign(new Error(`för liten, ${px[0]}×${px[1]}`), { unfit: true });
    await buildDay({ ...c, ...p, px, date }, true);
    used.add(c.id);
  }
  let made = 0;
  for (const date of dates) {
    if (made >= FILL_MAX) break;
    if (keepDay(await readDay(date))) continue;
    const n = Math.round(Date.parse(date) / dayMs);
    let done = false, tries = 0;
    // Image of the Day: samma dag i första hand, annars en färsk som blivit över de senaste sex dagarna.
    const fresh = iotd.filter(c => free(c) && c.date <= date && Date.parse(date) - Date.parse(c.date) <= 6 * dayMs)
      .sort((a, b) => b.date.localeCompare(a.date));
    for (const cand of fresh) {
      if (done || tries >= 2) break;
      tries++;
      try { await tryCandidate(date, cand); done = true; }
      catch (e) { console.warn(`${date}: ${cand.title} valdes bort (${e.message})`); if (e.unfit) skip.add(cand.id); }
      await pause();
    }
    // Arkivet: dagens ämne först, sedan nästa, tills en bild håller.
    for (let t = 0; t < TOPICS.length && !done && tries < 10; t++) {
      const topic = TOPICS[(n * 7 + t * 5) % TOPICS.length], center = CENTERS[(n + t) % CENTERS.length];
      let pool = [];
      try { pool = (await libraryCandidates(topic, center, 1 + (Math.floor(n / TOPICS.length) % 2))).filter(free); }
      catch (e) { console.warn(`${date}: arkivsökningen "${topic}" misslyckades (${e.message})`); continue; }
      for (const cand of pool.slice(0, 4)) {
        if (done || tries >= 10) break;
        tries++;
        try { await tryCandidate(date, cand); done = true; }
        catch (e) { console.warn(`${date}: ${cand.title} valdes bort (${e.message})`); if (e.unfit) skip.add(cand.id); }
        await pause();
      }
    }
    if (done) made++; else { failed++; console.error(`Hittade ingen NASA-bild för ${date}.`); }
  }
  await writeFile(SKIP_FILE, JSON.stringify([...skip], null, 1));
} catch (e) { failed++; console.error("Påfyllningen avbröts: " + e.message); }
await writeIndex();

// Jordbilderna: fel här stoppar inte resten, eftersom flödets form kan ändras.
try {
  const earth = await fetchEarth();
  console.log(`Jordflödet innehåller ${earth.length} godkända bilder.`);
  let made = 0;
  for (const e of earth) {
    if (made >= EARTH_MAX) break;
    if (existsSync(earthFile(e.date)) && (JSON.parse(await readFile(earthFile(e.date), "utf8")).v || 1) >= VERSION) continue;
    try { await buildEarth(e); made++; await wait(Number(process.env.PAUSE_MS ?? 13000)); }
    catch (err) { console.error(`Kunde inte skapa jordbild ${e.date}: ${err.message}`); }
  }
  await writeEarthIndex();
} catch (err) { console.error("Jordbilderna hoppades över: " + err.message); }

if (failed) process.exit(1);
