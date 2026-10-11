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

import { readFile, writeFile, readdir, mkdir, unlink } from "node:fs/promises";
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
const REJECT = new Set(["https://www.nasa.gov/image-detail/fd07_impact-flashes/", "GSFC_20171208_Archive_e001234", "southern_ring_nebula"]);
const MIN_LONG = 1000, MIN_SHORT = 600;   // minsta storlek i bildpunkter för att bilden ska hålla i helskärm
const bigEnough = px => Array.isArray(px) && Math.max(px[0], px[1]) >= MIN_LONG && Math.min(px[0], px[1]) >= MIN_SHORT;
const keepDay = d => Boolean(d && !d.sample && !d.removed && !REJECT.has(d.id) &&
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
    if (NOT_SPACE.test(title) || COMPOSITE.test(title)) continue;
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
// Hopsatta bilder ser trasiga ut i helskärm: jämförelser sida vid sida, kollage, före och efter, bilder med påskrifter.
const COMPOSITE = /comparison|compared|side[- ]by[- ]side|\bvs\.?\b|versus|montage|collage|mosaic of images|before and after|annotated|labell?ed|\bpanels?\b|\(left\)|\(right\)|images? side/i;
async function libraryCandidates(topic, center, page) {
  const url = `${LIBRARY}/search?q=${encodeURIComponent(topic)}&media_type=image&center=${center}&page_size=60&page=${page}`;
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`bildarkivet svarade ${res.status}`);
  const body = await res.json();
  return (body.collection?.items || []).map(it => it.data?.[0]).filter(Boolean).map(d => ({
    src: "library", id: d.nasa_id, title: String(d.title || "").trim(), explanation: strip(String(d.description || "")),
    credit: String(d.secondary_creator || d.photographer || "").trim() || "NASA/" + (d.center || center),
    link: "https://images.nasa.gov/details/" + encodeURIComponent(d.nasa_id)
  })).filter(c => c.id && c.title && c.explanation.length > 200 && nasaOwned(c.credit) && !NOT_PHOTO.test(c.title + " " + c.explanation.slice(0, 400)) && !COMPOSITE.test(c.title));
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

/* ---------- Äldre jordbilder ur arkivet ---------- */
const EARTH_BACK = Number(process.env.EARTH_BACK ?? 14);          // så här många dagar bakåt ska ha en jordbild
const EARTH_FILL_MAX = Number(process.env.EARTH_FILL_MAX ?? 12);
const EARTH_TOPICS = ["earth observatory landsat", "earth observatory volcano", "earth observatory glacier", "earth observatory river delta", "earth observatory island",
  "earth observatory desert", "earth observatory lake", "earth observatory phytoplankton bloom", "earth observatory coast", "earth observatory mountains",
  "earth observatory sea ice", "earth observatory city", "earth observatory reef", "earth observatory dunes"];
// Bara bilder där Earth Observatory uttryckligen står som upphov i NASA:s egen text.
const EO_CREDIT = /(NASA Earth Observatory images? (?:created )?by [^.]{3,160}\.?|(?:Image )?[Cc]redit: (?:Landsat \d\/)?NASA Earth Observatory|Landsat \d\/NASA Earth Observatory)/;
async function earthCandidates(topic, page) {
  const res = await fetch(`${LIBRARY}/search?q=${encodeURIComponent(topic)}&media_type=image&center=GSFC&page_size=60&page=${page}`, { headers: UA });
  if (!res.ok) throw new Error(`bildarkivet svarade ${res.status}`);
  const body = await res.json();
  return (body.collection?.items || []).map(it => it.data?.[0]).filter(Boolean).map(d => {
    const article = strip(String(d.description || "")), credit = (article.match(EO_CREDIT) || [])[0];
    return { src: "library", archive: true, id: d.nasa_id, title: String(d.title || "").replace(/\s*\[[^\]]*\]\s*$/, "").trim(), rawTitle: String(d.title || ""),
      article: article.slice(0, 6000), topics: (d.keywords || []).slice(0, 8).join(", "), credit: (credit || "").replace(/^(Image )?[Cc]redit:\s*/, "").replace(/\.$/, ""),
      source: credit || "", link: "https://images.nasa.gov/details/" + encodeURIComponent(d.nasa_id) };
  }).filter(c => c.id && c.title && c.credit && c.article.length > 300 && !/\[(annotated|detail|labeled|labelled)\]/i.test(c.rawTitle) && !/©|copyright|courtesy of (?!NASA)/i.test(c.source) && !/\b(image|images|photo|photograph|map|visualization)s? (is |are )?courtesy (?!of NASA|NASA)/i.test(c.article));
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

// Feltyper som hittats vid korrekturläsning av de första veckornas texter.
const LANGUAGE_RULES = `Språkregler som ofta bryts, kontrollera var och en:
- Rätt genus: ett rymdteleskop, ett svart hål, en galax, en nebulosa. Adjektiv och artiklar ska böjas efter substantivet (ett gigantiskt svart hål, inte gigantiska svarta hål när det är ett).
- Inga hemgjorda försvenskningar av engelska ord. Skriv kraterrik (inte kraterfierad), terrängen (inte terrainet), kretsloppet (inte cykeln) och andra etablerade svenska ord.
- Bara metriska mått. Räkna aldrig om till engelska mil, fot eller Fahrenheit.
- Kommatera sparsamt och bara där det hjälper läsningen. Hellre ett komma för lite än ett som hamnar fel. Dela hellre upp en lång mening i två.
- Använda dagens officiella namn på platser på andra himlakroppar (till exempel Sputnik Planitia på Pluto).
- Skriv varje sak en gång. Upprepa inte samma led två gånger i en mening.
- Bilder och liknelser ska gå att föreställa sig. Stryk hellre en liknelse än att skriva en som haltar.`;

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
   - Håll det kort, för frågan ska få plats på en mobilskärm tillsammans med svaren: högst 12 ord i frågan och högst 8 ord i varje alternativ.
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

${LANGUAGE_RULES}

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
${e.archive ? "\nBilden kommer ur arkivet och är inte ny. Skriv i förfluten tid om händelser, och nämn året bilden togs om det framgår av artikeln.\n" : ""}
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

${LANGUAGE_RULES}

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

// Modellen råkar ibland stoppa in enstaka tecken ur andra skriftsystem mitt i ord. De tas bort ur alla texter.
const FOREIGN = /[\u0400-\u052f\u0590-\u06ff\u0900-\u0dff\u0e00-\u0eff\u1100-\u11ff\u2e80-\u9fff\ua960-\ua97f\uac00-\ud7ff\uf900-\ufaff\uff00-\uffef]+/g;
const scrub = v => typeof v === "string" ? v.replace(FOREIGN, "") : Array.isArray(v) ? v.map(scrub)
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)])) : v;

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
  const content = scrub(JSON.parse(out));
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

// En andra genomläsning som bara rättar språket i de svenska texterna. Sakinnehåll, rätta svar och ordning får inte ändras.
// Går något fel, eller kommer svaret tillbaka i annan form, behålls den första versionen.
const PROOF_SCHEMA = { type: "OBJECT", required: ["title_sv", "levels", "terms"],
  properties: { title_sv: { type: "STRING" }, place_sv: { type: "STRING" }, quiz: QUIZ, levels: LEVELS, terms: TERMS } };
async function proofread(content) {
  if (process.env.PROOFREAD === "0") return content;
  const sv = { title_sv: content.title_sv, levels: content.levels, terms: content.terms };
  if (content.place_sv) sv.place_sv = content.place_sv;
  if (content.quiz) sv.quiz = content.quiz;
  const prompt = `Du är en noggrann svensk korrekturläsare. Texterna nedan ska visas i en app om rymden och jorden.

Rätta bara språket: stavning, genus och böjning (en/ett), särskrivningar, hemgjorda försvenskningar av engelska ord och meningar som haltar.
Flytta inte runt kommatecken i meningar som redan går att läsa. Ändra inte sakinnehåll, siffror, namn eller ordningen på något. Lägg inte till och ta inte bort meningar. Text som redan är korrekt lämnas orörd.
I quiz ska "correct" vara oförändrat och alternativen stå i samma ordning. I terms ska varje term fortfarande förekomma ordagrant i någon av texterna i levels.

${LANGUAGE_RULES}

Svara med samma JSON-struktur som du fick.

${JSON.stringify(sv)}`;
  const same = c => c && typeof c.title_sv === "string" && c.title_sv && okLevels(c.levels) && Array.isArray(c.terms) && c.terms.length === sv.terms.length &&
    (!sv.quiz || (Array.isArray(c.quiz) && c.quiz.length === sv.quiz.length && c.quiz.every((q, i) => q.q && q.fact && Array.isArray(q.options) && q.options.length === 3))) &&
    ["barn", "nyborjare", "entusiast"].every(k => Math.abs(c.levels[k].length - sv.levels[k].length) < sv.levels[k].length * 0.25);
  try {
    await wait(Number(process.env.PAUSE_MS ?? 13000));
    const { content: fixed } = await askGemini(prompt, PROOF_SCHEMA, same);
    const out = { ...content, title_sv: fixed.title_sv, levels: fixed.levels, terms: fixed.terms };
    if (sv.place_sv && fixed.place_sv) out.place_sv = fixed.place_sv;
    if (sv.quiz) out.quiz = fixed.quiz.map((q, i) => ({ ...q, correct: sv.quiz[i].correct }));
    return out;
  } catch (e) { console.warn("Språkgranskningen hoppades över: " + e.message); return content; }
}

async function needs(date) {
  if (!existsSync(fileFor(date))) return true;
  const old = JSON.parse(await readFile(fileFor(date), "utf8"));
  return Boolean(old.sample) || (old.v || 1) < VERSION; // exempeldagar och äldre versioner skrivs om
}

async function buildDay(apod, mustFit = false) {
  const { content, model } = await askGemini(promptFor(apod));
  if (mustFit && content.fits === false) { const e = new Error("bilden visar inte rymden"); e.unfit = true; throw e; }
  const checked = await proofread(content);
  content.title_sv = checked.title_sv; content.quiz = checked.quiz; content.levels = checked.levels; content.terms = checked.terms;
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
    list.push({ date: d.date, media_type: d.media_type, title: d.title_sv || d.title, title_en: d.title, thumb: d.thumb || d.url });
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
  const first = await askGemini(promptEarth(e), EARTH_SCHEMA, validEarth), model = first.model;
  const content = await proofread(first.content);
  const day = {
    v: VERSION, model, date: e.date, title: e.title, title_sv: content.title_sv, place: content.place_sv || "",
    url: e.url, thumb: e.thumb, hdurl: e.hdurl, link: e.link, credit: e.credit || "NASA Earth Observatory", source: e.source,
    src: e.src || "eo", id: e.id || e.link, archive: e.archive || undefined, px: e.px,
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
    list.push({ date: d.date, title: d.title_sv || d.title, title_en: d.title, place: d.place, place_en: d.en && d.en.place, thumb: d.thumb || d.url, archive: d.archive });
  }
  list.sort((a, b) => b.date.localeCompare(a.date));
  await writeFile(path.join(EARTH, "index.json"), JSON.stringify(list, null, 1));
}

await mkdir(DATA, { recursive: true });
await mkdir(EARTH, { recursive: true });
// Rättelser från korrektursidan (data/fixes.json): för varje fält den gamla och den nya texten.
// En rättelse görs bara om fältet fortfarande har den gamla texten, så att en bild som bytts ut inte får fel text.
async function applyFixes() {
  const file = path.join(DATA, "fixes.json");
  if (!existsSync(file)) return;
  const fixes = JSON.parse(await readFile(file, "utf8"));
  let done = 0, stale = 0, removed = 0;
  const gone = [];   // borttagna bilder ska inte väljas igen
  for (const [kind, dir] of [["space", DATA], ["earth", EARTH]]) {
    for (const [date, fix] of Object.entries(fixes[kind] || {})) {
      const target = path.join(dir, date + ".json");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !existsSync(target)) continue;
      const day = JSON.parse(await readFile(target, "utf8"));
      let changed = false;
      for (const [field, { from, to }] of Object.entries(fix.set || {})) {
        const keys = field.split("."), last = keys.pop();
        if (!/^(title_sv|place|quiz|levels|terms)$/.test(keys[0] || last)) continue;
        const holder = keys.reduce((o, k) => (o == null ? o : o[k]), day);
        if (!holder || typeof to !== "string") continue;
        if (holder[last] === to) continue;
        if (holder[last] !== from) { stale++; continue; }
        holder[last] = to; changed = true; done++;
      }
      if (fix.remove && !day.removed) {
        if (day.id) gone.push(day.id);
        if (kind === "earth") { await unlink(target); removed++; continue; }
        day.removed = true; changed = true; removed++;
      }
      if (changed) await writeFile(target, JSON.stringify(day, null, 2));
    }
  }
  if (gone.length) {
    const skip = new Set(existsSync(SKIP_FILE) ? JSON.parse(await readFile(SKIP_FILE, "utf8")) : []);
    gone.forEach(id => skip.add(id));
    await writeFile(SKIP_FILE, JSON.stringify([...skip], null, 1));
  }
  console.log(`Rättelser: ${done} fält ändrade, ${removed} bilder borttagna` + (stale ? `, ${stale} hoppades över eftersom texten redan var en annan` : "") + ".");
}
try { await applyFixes(); } catch (e) { console.error("Rättelserna kunde inte läsas: " + e.message); }

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

// Earth Observatory publicerar bara vissa vardagar. Övriga dagar fylls med äldre jordbilder ur NASA:s arkiv.
try {
  const skip = new Set(existsSync(SKIP_FILE) ? JSON.parse(await readFile(SKIP_FILE, "utf8")) : []);
  const used = new Set();
  for (const f of (await readdir(EARTH)).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))) {
    const d = JSON.parse(await readFile(path.join(EARTH, f), "utf8"));
    if (REJECT.has(d.id)) { await unlink(path.join(EARTH, f)); skip.add(d.id); console.log(`Jordbild ${d.date} (${d.title}) tas bort och ersätts.`); continue; }
    if (d.id) used.add(d.id); used.add(String(d.title).toLowerCase());
  }
  const dayMs = 864e5, today = new Date().toISOString().slice(0, 10);
  let made = 0;
  for (let i = 0; i < EARTH_BACK && made < EARTH_FILL_MAX; i++) {
    const date = new Date(Date.parse(today) - i * dayMs).toISOString().slice(0, 10);
    if (existsSync(earthFile(date))) continue;
    const n = Math.round(Date.parse(date) / dayMs);
    let done = false, tries = 0;
    for (let t = 0; t < EARTH_TOPICS.length && !done && tries < 8; t++) {
      let pool = [];
      try { pool = (await earthCandidates(EARTH_TOPICS[(n * 5 + t) % EARTH_TOPICS.length], 1 + (Math.floor(n / EARTH_TOPICS.length) % 2))).filter(c => !used.has(c.id) && !used.has(c.title.toLowerCase()) && !skip.has(c.id)); }
      catch (e) { console.warn(`Jorden ${date}: arkivsökningen misslyckades (${e.message})`); continue; }
      for (const cand of pool.slice(0, 4)) {
        if (done || tries >= 8) break;
        tries++;
        try {
          const c = await libraryAsset(cand), px = await measure(c.url);
          if (!bigEnough(px)) throw Object.assign(new Error(`för liten, ${px[0]}×${px[1]}`), { unfit: true });
          await buildEarth({ ...c, px, date }); used.add(c.id); used.add(c.title.toLowerCase()); done = true;
        } catch (e) { console.warn(`Jorden ${date}: ${cand.title} valdes bort (${e.message})`); if (e.unfit) skip.add(cand.id); }
        await pause();
      }
    }
    if (done) made++; else console.error(`Hittade ingen jordbild för ${date}.`);
  }
  await writeFile(SKIP_FILE, JSON.stringify([...skip], null, 1));
  await writeEarthIndex();
} catch (err) { console.error("Påfyllningen av jordbilder hoppades över: " + err.message); }

// Ordlistan: alla ord som förklarats vid bilderna, plus några grundord, samlade i en fil per språk.
try {
  const BASE = {
    sv: [["galax", "En enorm samling av stjärnor, gas och stoft som hålls ihop av gravitationen. Vår egen heter Vintergatan."],
      ["nebulosa", "Ett moln av gas och stoft i rymden. I vissa föds nya stjärnor, andra är rester av stjärnor som har dött."],
      ["ljusår", "Sträckan ljuset hinner på ett år, ungefär 9 500 miljarder kilometer. Används för avstånd mellan stjärnor."],
      ["supernova", "En stjärna som exploderar i slutet av sitt liv och under en kort tid kan lysa starkare än en hel galax."],
      ["svart hål", "Ett område där gravitationen är så stark att inte ens ljus kan ta sig därifrån."],
      ["komet", "En klump av is och stoft som kretsar kring solen och får en lysande svans när den värms upp."],
      ["meteor", "Ljusstrecket som syns när ett litet stenkorn från rymden brinner upp i jordens atmosfär. Kallas också stjärnfall."],
      ["solstorm", "Ett utbrott på solen som slungar ut laddade partiklar. När de når jorden kan de ge norrsken och störa elnät och satelliter."],
      ["norrsken", "Ljus på natthimlen som uppstår när laddade partiklar från solen träffar luften högt över jordens poler."],
      ["Kp-index", "Ett mått från 0 till 9 på hur orolig jordens magnetfält är. Ju högre värde, desto längre söderut kan norrsken synas."],
      ["exoplanet", "En planet som kretsar kring en annan stjärna än solen."],
      ["omloppsbana", "Den bana ett föremål följer runt ett annat, till exempel månens väg runt jorden."],
      ["solförmörkelse", "När månen passerar mellan solen och jorden och skymmer solen helt eller delvis."],
      ["månförmörkelse", "När jorden hamnar mellan solen och månen, så att jordens skugga faller på månen."]],
    en: [["galaxy", "A vast collection of stars, gas and dust held together by gravity. Our own is the Milky Way."],
      ["nebula", "A cloud of gas and dust in space. New stars are born in some; others are the remains of stars that have died."],
      ["light-year", "The distance light travels in a year, about 9.5 trillion kilometres. Used for distances between stars."],
      ["supernova", "A star that explodes at the end of its life and for a short time can outshine an entire galaxy."],
      ["black hole", "A region where gravity is so strong that not even light can escape."],
      ["comet", "A lump of ice and dust orbiting the Sun that grows a glowing tail when it warms up."],
      ["meteor", "The streak of light seen when a small grain of rock from space burns up in Earth's atmosphere. Also called a shooting star."],
      ["solar storm", "An outburst on the Sun that flings out charged particles. When they reach Earth they can cause aurora and disturb power grids and satellites."],
      ["aurora", "Light in the night sky that appears when charged particles from the Sun hit the air high above Earth's poles."],
      ["Kp index", "A scale from 0 to 9 of how disturbed Earth's magnetic field is. The higher the value, the further from the poles aurora can be seen."],
      ["exoplanet", "A planet orbiting a star other than the Sun."],
      ["orbit", "The path one object follows around another, such as the Moon's path around Earth."],
      ["solar eclipse", "When the Moon passes between the Sun and Earth and hides the Sun fully or partly."],
      ["lunar eclipse", "When Earth comes between the Sun and the Moon, so that Earth's shadow falls on the Moon."]]
  };
  const words = { sv: new Map(), en: new Map() };
  const add = (lang, term, text, ref) => {
    const t = String(term || "").trim(), key = t.toLowerCase();
    if (t.length < 3 || !text) return;
    if (!words[lang].has(key)) words[lang].set(key, { t, e: String(text).trim(), d: [] });
    const w = words[lang].get(key);
    if (ref && w.d.length < 4 && !w.d.includes(ref)) w.d.push(ref);
  };
  for (const [dir, prefix] of [[DATA, ""], [EARTH, "jorden-"]]) {
    const files = (await readdir(dir)).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse();
    for (const f of files) {
      const d = JSON.parse(await readFile(path.join(dir, f), "utf8"));
      if (dir === DATA && !keepDay(d)) continue;
      for (const t of d.terms || []) add("sv", t.term, t.explanation, prefix + d.date);
      for (const t of (d.en && d.en.terms) || []) add("en", t.term, t.explanation, prefix + d.date);
    }
  }
  for (const lang of ["sv", "en"]) for (const [t, e] of BASE[lang]) add(lang, t, e, null);
  const sorted = lang => [...words[lang].values()].sort((a, b) => a.t.localeCompare(b.t, lang, { sensitivity: "base" }));
  await writeFile(path.join(DATA, "glossary.json"), JSON.stringify({ sv: sorted("sv"), en: sorted("en") }));
  console.log(`Ordlistan: ${words.sv.size} svenska och ${words.en.size} engelska ord.`);
} catch (e) { console.error("Ordlistan hoppades över: " + e.message); }

// Just nu på jorden: pågående naturhändelser ur NASA:s tjänst EONET, sparade för appen. Fel här stoppar ingenting.
try {
  const res = await fetch("https://eonet.gsfc.nasa.gov/api/v3/events?status=open", { headers: UA });
  if (!res.ok) throw new Error(`EONET svarade ${res.status}`);
  const list = (await res.json()).events || [], now = Date.now(), dayMs = 864e5;
  const STORM = [["Super Typhoon", "Supertyfonen"], ["Typhoon", "Tyfonen"], ["Hurricane", "Orkanen"], ["Tropical Storm", "Tropiska stormen"], ["Tropical Depression", "Tropiska lågtrycket"],
    ["Subtropical Storm", "Subtropiska stormen"], ["Tropical Cyclone", "Tropiska cyklonen"], ["Cyclone", "Cyklonen"]];
  // Grovt havsområde ur läget: [svenska, engelska]
  const basin = (lon, lat) => lat >= 0
    ? (lon < -100 || (lon < -80 && lat < 16) ? ["östra Stilla havet", "eastern Pacific"] : lon <= 20 ? ["Atlanten", "Atlantic"] : lon < 100 ? ["norra Indiska oceanen", "northern Indian Ocean"] : ["västra Stilla havet", "western Pacific"])
    : (lon >= 20 && lon < 135 ? ["södra Indiska oceanen", "southern Indian Ocean"] : lon >= 135 || lon < -70 ? ["södra Stilla havet", "southern Pacific"] : ["Sydatlanten", "South Atlantic"]);
  const sv = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " "), en = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const out = { storm: [], volcano: [], ice: [], fire: [], other: [] };
  for (const ev of list) {
    const geo = (ev.geometry || []).filter(g => g && g.date), first = geo[0], last = geo[geo.length - 1];
    if (!last) continue;
    const cat = (ev.categories || [])[0] || {}, age = (now - Date.parse(last.date)) / dayMs, point = last.type === "Point" ? last.coordinates : null;
    const title = String(ev.title || "").trim(), mag = Number(last.magnitudeValue), unit = last.magnitudeUnit;
    if (cat.id === "severeStorms") {
      if (age > 3) continue;   // stormar som inte uppdaterats på flera dygn står ofta kvar som öppna
      const hit = STORM.find(([e]) => title.startsWith(e + " "));
      const kmh = unit === "kts" && mag ? Math.round(mag * 1.852 / 5) * 5 : 0, where = point ? basin(point[0], point[1]) : ["", ""];
      out.storm.push({ kind: "storm", date: last.date, rank: kmh, title_sv: hit ? hit[1] + title.slice(hit[0].length) : title, title_en: title,
        where_sv: where[0].replace(/^./, c => c.toUpperCase()), where_en: where[1].replace(/^./, c => c.toUpperCase()), value_sv: kmh ? `vindar på ${kmh} km/h` : "", value_en: kmh ? `winds of ${kmh} km/h` : "" });
    } else if (cat.id === "wildfires") {
      if (/prescribed|\bRX\b/i.test(title) || (now - Date.parse(first.date)) / dayMs > 10) continue;   // planerade bränningar och gamla bränder hoppas över
      const place = title.replace(/^Wildfire\s+/i, "").split(",").slice(1).map(x => x.trim()).filter(Boolean).join(", ");
      const ha = unit === "acres" && mag ? Math.round(mag * 0.4047 / 10) * 10 : 0;
      if (!place) continue;
      out.fire.push({ kind: "fire", date: first.date, rank: ha, title_sv: "Skogsbrand i " + place, title_en: "Wildfire in " + place, where_sv: "", where_en: "", value_sv: ha ? sv(ha) + " hektar" : "", value_en: ha ? en(ha) + " hectares" : "" });
    } else {
      if (age > 30) continue;
      const kind = cat.id === "volcanoes" ? "volcano" : cat.id === "seaLakeIce" ? "ice" : "other";
      const label = { volcanoes: ["Vulkanutbrott", "Volcanic eruption"], seaLakeIce: ["Is och isberg", "Ice and icebergs"], floods: ["Översvämning", "Flood"], earthquakes: ["Jordbävning", "Earthquake"],
        landslides: ["Jordskred", "Landslide"], dustHaze: ["Stoft och dis", "Dust and haze"], drought: ["Torka", "Drought"], snow: ["Snö", "Snow"], tempExtremes: ["Extrem temperatur", "Extreme temperature"],
        waterColor: ["Färgat vatten", "Water colour"], manmade: ["Orsakat av människor", "Man-made"] }[cat.id] || [cat.title || "", cat.title || ""];
      if (kind === "other" && age > 7) continue;
      // Isberg får sitt hav i stället för kategorins namn, som bara upprepar vad det är.
      const sea = kind === "ice" && point ? (point[1] < -50 ? ["Södra ishavet, vid Antarktis", "Southern Ocean, near Antarctica"] : point[1] > 60 ? ["Norra ishavet", "Arctic Ocean"] : basin(point[0], point[1]).map(x => x.replace(/^./, c => c.toUpperCase()))) : label;
      out[kind].push({ kind, date: last.date, rank: -age, title_sv: title.replace(/^Iceberg /, "Isberget "), title_en: title, where_sv: sea[0], where_en: sea[1], value_sv: "", value_en: "" });
    }
  }
  const top = (a, n) => a.sort((x, y) => y.rank - x.rank).slice(0, n).map(({ rank, ...e }) => e);
  const events = [...top(out.storm, 3), ...top(out.volcano, 2), ...top(out.ice, 1), ...top(out.fire, 2), ...top(out.other, 2)];
  await writeFile(path.join(DATA, "now.json"), JSON.stringify({ updated: new Date().toISOString(), source: "NASA EONET", events }, null, 1));
  console.log(`Just nu på jorden: ${events.length} händelser av ${list.length} öppna.`);
} catch (e) { console.error("Just nu på jorden hoppades över: " + e.message); }

if (failed) process.exit(1);
