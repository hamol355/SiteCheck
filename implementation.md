# Implementationsplan – SiteCheck v1.0.0

> Status 2026-10-28: M1–M5 klara. M6 (blockerade sajter), M7 (WCAG) och M8 (flera sidor via sitemap) läggs till före release. Release (M9) är ett mål, inte en deadline.

Det här dokumentet bryter ner roadmapen i [SiteCheck.md](SiteCheck.md) till konkreta steg. Regler och konventioner finns i [CLAUDE.md](CLAUDE.md); vid konflikt gäller CLAUDE.md.

## 1. Avvikelser från roadmapen i specen

| Spec                                         | Här                                                          | Varför                                                     |
| -------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------- |
| JSON: `checks` är en bool-map                | JSON: `checks` är en lista med id/status/message/remediation | Publikt gränssnitt som ska tåla nya kontroller (CLAUDE.md) |
| "Saknad `<title>`" listas under HTML och SEO | En enda `title`-kontroll i SEO                               | Undviker dubbelräkning                                     |
| "Om webbplatsen går att nå" som kontroll     | Onåbar sida avbryter körningen med exit code 3               | Det går inte att ge en meningsfull score utan svar         |
| Fler WCAG-kontroller är "framtida"           | Tas med före release (M7), kategori `accessibility` ersätter `html` | Beslut 2026-10-28; release är ett mål, inte en deadline    |
| Bara startsidan analyseras                   | Valfritt flera sidor via sitemap (`--pages`, M8)             | Fler sidor ger en rättvisare bild av tillgängligheten      |
| Blockerad sajt ger score på blocksidan       | Blockerad startsida ger "access not allowed" + orsak, ingen score (M6) | En score på en challenge-sida är missvisande |

## 2. Beslut som gäller genom hela projektet

- **Node 22 LTS+** (Node 20 är EOL sedan april 2026), ESM (`"type": "module"`), TypeScript `strict`.
- **Beroenden:** runtime `commander`, `cheerio`; dev `typescript`, `vitest`, `eslint` (+ `typescript-eslint`), `prettier`, `tsx`. Ingen axios/node-fetch.
- **Response time** = tid från att sista requesten skickas tills svarshuvudena tagits emot (kan inkludera DNS/TLS – vid redirect till samma host återanvänder `fetch`/undici anslutningen och då ingår de inte; exkl. redirects före den, body-läsning och parsning). Dokumenteras i kod och README.
- **Nätverk** sker bara i `src/net/http.ts`: timeout 10 s (5 s för robots/sitemap), max 5 redirects (manuell loop, bara `http:`/`https:`), body-tak 2 MB (1 MB för robots/sitemap), `User-Agent: SiteCheck/<version>`.
- **Motorn** (`src/checks`, `src/scoring`, `src/net`, `src/index.ts`) importerar aldrig `src/cli` och skriver aldrig till stdout/stderr.
- **Blockering:** SiteCheck försöker aldrig ta sig förbi bot-skydd (inga UA-knep, ingen challenge-lösning). Blockeras startsidan avbryts körningen med `BlockedError` och en tydlig orsak, se avsnitt 5b. Det är en medveten ändring av tidigare beteende (403 → `http-status` fail + skippade sidkontroller).
- **Höflighet vid flera sidor:** `robots.txt` respekteras för alla extra sidor vi hämtar (Disallow för `SiteCheck` eller `*`), max 4 samtidiga requests, hårt tak 50 sidor.

## 3. Målstruktur

```text
src/
  cli/index.ts          # Commander, flaggor, mappning fel → exit code
  cli/exit-codes.ts     # EXIT_OK=0, EXIT_BELOW_MIN_SCORE=1, EXIT_USAGE=2, EXIT_UNREACHABLE=3
  cli/url.ts            # normalizeUrl()
  net/http.ts           # fetchPage(), fetchText(), probeHttpRedirect()
  net/sitemap.ts        # (M8) parseSitemap(), samplePages(): index, gzip, tak, same-origin
  checks/types.ts       # CheckResult, Category, Status, CheckDefinition
  checks/run.ts         # safeRun(), runChecks()
  checks/blocked.ts     # (M6) detectBlock(page, robots) → BlockReason | null, BlockedError
  checks/availability.ts
  checks/security.ts
  checks/seo.ts
  checks/html.ts
  checks/accessibility.ts  # (M7) WCAG-kontroller på statisk HTML
  aggregate.ts          # (M8) slår ihop per-sida-resultat till ett resultat per check-id
  scoring/score.ts      # WEIGHTS, GRADES, calculateScore()
  output/terminal.ts
  output/json.ts
  index.ts              # analyze(url): Promise<Report>
tests/
  fixtures/             # headers-*.json, *.html, robots/sitemap-exempel
  helpers/test-server.ts
  *.test.ts             # en per modul + cli.integration.test.ts
```

## 4. Kärnkontrakt

```ts
export type Category = 'availability' | 'security' | 'seo' | 'html';
export type Status = 'pass' | 'warn' | 'fail' | 'error' | 'skip';

export interface CheckResult {
  id: string; // kebab-case, t.ex. 'content-security-policy'
  category: Category;
  status: Status;
  message: string; // visas i terminal och JSON
  remediation?: string; // visas för warn/fail
  points: number; // intjänade poäng
  maxPoints: number;
}

export interface FetchedPage {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  headers: Record<string, string>; // lowercase-nycklar
  html: string | null; // null om content-type inte är HTML
  truncated: boolean;
  responseTimeMs: number;
  redirects: { from: string; to: string; status: number }[];
}

export interface Report {
  schemaVersion: 1;
  url: string;
  finalUrl: string;
  score: number;
  grade: 'Excellent' | 'Good' | 'Needs improvement' | 'Poor';
  categories: Record<Category, { score: number; max: number }>;
  checks: CheckResult[];
  meta: { sitecheckVersion: string; analyzedAt: string; responseTimeMs: number; truncated: boolean };
}
```

Planerade tillägg (M6–M8), alla additiva utom kategoribytet `html` → `accessibility` i M7.

**`schemaVersion`:** förblir `1`. Inget är publicerat än (0.1.0, npm-release i M9), så det finns inga konsumenter att bryta; schema 1 är det som släpps i v1.0.0. Från v1.0.0 är schemat fryst: icke-additiva ändringar höjer `schemaVersion`. Släpps 1.0.0 före M7 blir M7:s kategoribyte `schemaVersion: 2`.

```ts
// M7: Category blir 'availability' | 'security' | 'seo' | 'accessibility' ('html' tas bort). CheckDefinition/CheckResult får wcag?: string[] (t.ex. ['2.4.4']).
// M6
export type BlockReason = 'unauthorized' | 'forbidden' | 'rate-limited' | 'challenge' | 'robots-disallow';
export class BlockedError extends Error { reason: BlockReason; status: number | null; url: string }
// M8: Report får
//   pages?: { url: string; status: number | null; skipped?: string; checks: Pick<CheckResult,'id'|'status'|'message'>[] }[];
//   meta.pagesAnalyzed: number;
```

Poäng per status: `pass` = maxPoints, `warn` = hälften (avrundat nedåt), `fail`/`error` = 0. `error`-kontroller räknas dock inte alls i scoring (se avsnitt 6). Helper `makeResult(def, status, message, remediation?)` räknar ut `points` så att kontroller aldrig hanterar poäng själva.

`safeRun(def, fn)` fångar alla undantag och returnerar `status: 'error'` med meddelandet "Check failed to run: …". En kraschande kontroll påverkar inte övriga, och CLI:t skriver en varning till stderr.

## 5. Kontrollkatalog

Poängen är relativa inom kategorin; kategorin normaliseras mot sin vikt (20/40/20/20), se avsnitt 6. Summan per kategori är satt till vikten så att råpoäng = slutpoäng.

### Availability (20)

| id               | max | pass                                                                  | warn                                                                   | fail                                 |
| ---------------- | --- | --------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------ |
| `http-status`    | 8   | slutlig status 2xx                                                    | 3xx som inte följts (utan `Location`, 300, 304 …)                      | 4xx/5xx (401/403/429 på startsidan ger i stället blockering, se 5b) |
| `response-time`  | 6   | < 500 ms                                                              | 500–1499 ms                                                            | ≥ 1500 ms                            |
| `https-redirect` | 6   | `http://`-kedjan slutar med 301/302/307/308 med `Location: https://…` | kedjan slutar på `http://` med annan status, eller port 80 svarar inte | kedjan slutar med 200 över `http://` |

Fler än 5 redirects (inkl. redirect-loopar) ger `TooManyRedirectsError` och behandlas som onåbar sida (exit 3), inte som ett kontrollresultat.

`https-redirect` kräver extra requests (`probeHttpRedirect`). Den testar `http://` för den host användaren angav (det besökare skriver), inte slutlig URL, och följer `http://`→`http://`-redirects (t.ex. till `www`) men begär aldrig själva https-målet. Max 5 redirects och 5 s totalt. Körs parallellt med huvudanropet och avbryts om det misslyckas. Gäller även om användaren angav `http://`.

### Security (40)

| id                          | max | pass                                                                   | warn                                                            | fail                                      |
| --------------------------- | --- | ---------------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------- |
| `https`                     | 10  | slutlig URL är `https:`                                                | –                                                               | `http:`                                   |
| `strict-transport-security` | 8   | `max-age` ≥ 15552000 (6 mån)                                           | `max-age` > 0 men kortare                                       | saknas, eller sidan levererades över http |
| `content-security-policy`   | 8   | finns, utan `unsafe-inline`/`unsafe-eval` i `default-src`/`script-src` | finns men med `unsafe-*`, eller utan `default-src`/`script-src` | saknas                                    |
| `x-content-type-options`    | 5   | `nosniff`                                                              | –                                                               | saknas/annat värde                        |
| `referrer-policy`           | 5   | finns och är inte `unsafe-url`                                         | finns men `unsafe-url`/`no-referrer-when-downgrade`             | saknas, eller inget giltigt värde         |
| `permissions-policy`        | 4   | finns                                                                  | bara legacy `Feature-Policy`                                    | saknas                                    |

Alla har `remediation` med exempelheader, t.ex. `Add header: X-Content-Type-Options: nosniff`.

Tolkning av headers: `fetch` slår ihop upprepade headers med `, `. För HSTS gäller bara den första; för CSP kontrolleras varje policy för sig och ett `unsafe-*`-nyckelord räknas bara om alla policyer som begränsar skript tillåter det. `'unsafe-inline'` ignoreras när samma direktiv har en nonce eller hash (som i webbläsaren). För `Referrer-Policy` gäller sista token som webbläsaren känner igen.

### SEO (20)

| id                 | max | pass                                                                                                                                                                             | warn                     | fail          |
| ------------------ | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------- |
| `title`            | 4   | finns och ≤ 60 tecken                                                                                                                                                            | finns men annan längd    | saknas/tom    |
| `meta-description` | 4   | 50–160 tecken                                                                                                                                                                    | finns men annan längd    | saknas/tom    |
| `h1`               | 3   | exakt en `<h1>`                                                                                                                                                                  | fler än en               | ingen         |
| `canonical-url`    | 3   | `<link rel="canonical" href>` med absolut URL                                                                                                                                    | relativ href             | saknas        |
| `robots-txt`       | 3   | 200 och inte HTML                                                                                                                                                                | –                        | 404/annat fel |
| `sitemap-xml`      | 3   | URL från `Sitemap:` i robots.txt (annars `/sitemap.xml`) ger 200 och innehåller `<urlset`/`<sitemapindex`, eller är gzip (`.gz`/`application/gzip`, innehållet inspekteras inte) | 200 men inte XML-sitemap | saknas        |

### HTML (20)

| id                  | max | pass                                                                | warn                                                                | fail          |
| ------------------- | --- | ------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------- |
| `html-lang`         | 5   | icke-tomt `lang` på `<html>`                                        | –                                                                   | saknas/tomt   |
| `viewport-meta`     | 5   | innehåller `width=device-width`                                     | finns men utan det                                                  | saknas        |
| `image-alt`         | 6   | alla `<img>` har `alt` (tomt `alt=""` är giltigt) eller inga bilder | ≤ 20 % saknar `alt` (meddelande: "3 images missing alt attributes") | > 20 % saknar |
| `heading-structure` | 4   | inga hopp > 1 nivå (saknad/felplacerad h1 ingår i `h1`)             | hopp i nivåer                                                       | inga rubriker |

Sidan svarade inte 2xx: SEO-sidkontroller och HTML-kontroller returnerar `skip` ("Skipped title: page responded with HTTP 404") och räknas inte i scoring – en fel- eller blocksida säger inget om den riktiga sidan. Icke-HTML-svar (`html === null`) med 2xx: de returnerar `fail` med meddelandet "Response is not HTML". `robots-txt` och `sitemap-xml` körs i båda fallen.

`title` och `meta-description` mäts efter att blanktecken slagits ihop (som `document.title`); `<title>` inuti inline-SVG ignoreras. `heading-structure` kontrollerar bara hopp i nivåer så att en saknad `<h1>` inte straffas två gånger. `robots.txt` hämtas parallellt med https-proben och skickar `Accept: */*`.

## 5b. Blockerade sajter (M6)

Om sajten inte tillåter automatiska besökare ska SiteCheck säga det rakt ut, inte ge en score på en blocksida.

`detectBlock(page, robots)` är en ren funktion (testbar utan nätverk) som körs på startsidans svar innan några kontroller körs:

| reason            | Signal                                                                                                                   | Meddelande (stderr)                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `unauthorized`    | HTTP 401                                                                                                                 | The site requires authentication (HTTP 401)                                               |
| `forbidden`       | HTTP 403 utan challenge-signal                                                                                           | The site refused the request (HTTP 403), probably bot protection or a firewall rule       |
| `rate-limited`    | HTTP 429                                                                                                                 | The site is rate limiting requests (HTTP 429)                                             |
| `challenge`       | `cf-mitigated: challenge`, eller 403/429/503 där body/headers matchar kända challenge-sidor (Cloudflare "Just a moment", DataDome, Akamai, PerimeterX, captcha) | The site served a bot-protection challenge                                |
| `robots-disallow` | `robots.txt` har Disallow som täcker startsidans path för `SiteCheck` eller `*`                                          | robots.txt does not allow automated access to this page                                   |

- Mönstren för challenge-sidor ligger som konstanter på ett ställe (`checks/blocked.ts`).
- **robots.txt-tolkning** (RFC 9309): gruppen för `SiteCheck` används om den finns, annars `*`; längsta matchande regel vinner, `Allow` vinner vid lika längd; `*` och `$` i mönster stöds. Matchas mot slutlig URL:s path + query (det är den sidan som analyseras). robots.txt som svarar 4xx (inkl. 401/403/418) eller inte går att hämta = allt tillåtet (Googles konvention); 5xx = allt tillåtet men notis på stderr (vi låter inte en trasig robots.txt blockera analysen). Startsidan hämtas parallellt med robots.txt; vid Disallow kastas svaret och ingen rapport skapas.
- Konsekvens att dokumentera i README: många sajter har `User-agent: *` / `Disallow: /` och släpper bara in namngivna sökmotorer – de ger "access not allowed".
- Alla meddelanden slutar med en hint: SiteCheck identifierar sig ärligt (`SiteCheck/<version>`) och försöker inte kringgå skyddet; be sajtägaren släppa igenom user-agenten, eller kör mot en miljö utan bot-skydd.
- `analyze()` kastar `BlockedError` (reason, status, url), definierad i `checks/blocked.ts` bredvid `BlockReason` och re-exporterad från `index.ts` som övriga feltyper. CLI skriver `Access not allowed: <meddelande>` till stderr, inget på stdout, exit code 3 (samma som onåbar sida – inget nytt exit code i kontraktet; kan delas ut till eget senare om CI-användare behöver skilja dem).
- 404 och 5xx är inte blockering utan ger som tidigare `http-status` fail och skippade sidkontroller.
- Gäller bara startsidan. Extra sidor via sitemap (M8) som blockeras eller är disallowed i robots.txt hoppas över (`skipped` på sidan, med orsak) och påverkar inte scoring.
- Begränsning: en sajt som svarar 200 med ett reducerat bot-skal kan inte upptäckas på ett tillförlitligt sätt och bedöms som den levereras (dokumenteras i README).

## 5c. Accessibility (M7)

Ny kategori `accessibility` som **ersätter `html`**, endast statisk HTML via Cheerio (ingen JS-rendering, ingen CSS). Poängen är relativa; kategorin normaliseras mot sin vikt som övriga. `image-alt`, `html-lang` och `heading-structure` flyttas hit från `html`, och `viewport-meta` flyttas till `seo` (mobilanpassning är en rankningssignal) – ids oförändrade. Kategorin `html` tas bort; annars hade den bara haft en kontroll (`viewport-meta`) som ensam styrt hela kategorins vikt. Varje check har `wcag`-referens (WCAG 2.2) och `remediation`.

| id               | WCAG       | max | pass                                                                                        | warn                                    | fail                       |
| ---------------- | ---------- | --- | ------------------------------------------------------------------------------------------- | --------------------------------------- | -------------------------- |
| `link-name`      | 2.4.4, 4.1.2 | 4 | alla `<a href>` har tillgängligt namn (text, `aria-label`, `aria-labelledby`, `<img alt>`) | ≤ 20 % saknar                           | > 20 % saknar              |
| `button-name`    | 4.1.2      | 3   | alla knappar (`button`, `input[type=button/submit/reset]`, `role=button`) har namn          | ≤ 20 % saknar                           | > 20 % saknar              |
| `form-label`     | 1.3.1, 3.3.2 | 5 | alla fält (utom hidden/submit/button) har `label for`, omslutande label, `aria-label(ledby)` | ≤ 20 % saknar                          | > 20 % saknar              |
| `iframe-title`   | 4.1.2      | 2   | alla `<iframe>` har icke-tom `title` (eller inga iframes)                                   | –                                       | någon saknar               |
| `landmarks`      | 1.3.1, 2.4.1 | 3 | exakt en `<main>`/`role=main`                                                               | flera `main`                            | ingen `main`               |
| `aria-valid`     | 4.1.2      | 4   | giltiga roller, `aria-labelledby/describedby/controls` pekar på befintliga id, ingen `aria-hidden` på fokuserbara element | –                  | något brott                |
| `zoom-allowed`   | 1.4.4      | 2   | viewport har inte `user-scalable=no`/`0`, och `maximum-scale` saknas eller är ≥ 2           | –                                       | `user-scalable=no`/`0` eller `maximum-scale` < 2 |
| `tabindex`       | 2.4.3      | 1   | inget `tabindex` > 0                                                                        | –                                       | finns                      |
| `meta-refresh`   | 2.2.1      | 1   | ingen `<meta http-equiv=refresh>` med fördröjning > 0                                       | –                                       | finns                      |

- Max-poäng är preliminära och justeras efter manuell testrunda. Fas B (om tid finns): tabellrubriker (1.3.1), `autocomplete` på personuppgiftsfält (1.3.5), `<video autoplay>` utan `muted` (1.4.2).
- Går inte att göra statiskt och lovas inte: kontrast (1.4.3), fokusindikator, tangentbordsfällor. Kräver headless browser (Playwright + axe-core) och är ett separat beslut; listas som begränsning i README.

## 5d. Flera sidor via sitemap (M8)

- `--pages <n>` (default 1, max 50). Med 1 sida är beteendet oförändrat.
- **Hämtning av sitemap:** ny `fetchBytes(url, opts)` i `net/http.ts` som returnerar rå `Buffer` + `truncated` (samma timeout/redirect/body-tak som `fetchText`). `fetchText` duger inte: den avkodar till sträng med `TextDecoder`, vilket förstör gzip, och exponerar inte `truncated`. Avkodning (gunzip, sedan UTF-8) sker i `net/sitemap.ts`.
- **Sitemap-läsare** (`net/sitemap.ts`, bygger på `fetchBytes`): läser `<loc>` ur `<urlset>`, följer `<sitemapindex>` max 2 nivåer och max 10 barn-sitemaps, gunzippar `.gz` med tak på uppackad storlek (skydd mot zip-bomb), max 5 000 URL:er totalt. Saknas eller är sitemapen ogiltig analyseras bara startsidan, med en notis på stderr.
- **Filtrering:** endast samma origin som slutlig startsida, endast `http:`/`https:`, deduplicerat, filändelser som inte är HTML (pdf, bilder …) bort, och URL:er som `robots.txt` inte tillåter bort. Utan same-origin-filtret kunde en elak sitemap få SiteCheck att anropa godtyckliga hosts (SSRF).
- **Sitemap-filerna själva** får ligga på annan host (vanligt med CDN; `sitemap-xml` följer redan `Sitemap:`-direktivet dit), men bara `http:`/`https:` och bara URL:er från robots.txt eller ett `<sitemapindex>`. Same-origin-kravet gäller sidorna som analyseras. När SSRF-skyddet läggs till (REST API) gäller det även sitemap-anropen, eftersom allt går via `net/http.ts`.
- **www / icke-www** räknas som olika origin (ingen gissning). Filtreras alla sitemap-URL:er bort skrivs en notis på stderr ("Sitemap has no URLs on <origin>; analysing the start page only") och bara startsidan analyseras.
- **Urval:** startsidan alltid med; resten deterministiskt utspritt, grupperat på första path-segmentet så att olika mallar (blogg, produkt …) täcks. Samma indata ger samma urval.
- **Hämtning:** `fetchPage` per sida, max 4 samtidiga. Misslyckad, blockerad eller icke-HTML-sida blir `skipped` med orsak och avbryter inte körningen. Redirect som leder utanför origin → hoppas över.
- **Vilka kontroller:** per sida kör `accessibility` och sid-kontrollerna i `seo` (`title`, `meta-description`, `h1`, `canonical-url`, `viewport-meta`). Per sajt, bara på startsidan: `availability`, `security`, `robots-txt`, `sitemap-xml`.
- **Aggregering** (`aggregate.ts`) ger ett resultat per check-id så att scoring och `checks` i JSON är oförändrade: poäng = medelvärdet av sidornas poäng avrundat nedåt till heltal (`Math.floor`, samma riktning som `warn` = hälften nedåt; `points` förblir heltal); status `pass` om alla sidor passerar, `fail` om fler än hälften failar, annars `warn`. Status och poäng räknas oberoende av varandra – status är en sammanfattning för läsaren, poängen styr scoring – så t.ex. 5 pass + 5 fail ger `warn` med halva poängen; meddelande t.ex. "3 of 10 pages: images missing alt attributes". Detaljerna per sida ligger i det nya valfria fältet `pages` (additivt, `schemaVersion` förblir 1). `skip` sidor räknas inte.
- Terminal: under varje icke-pass check visas de första 3 URL:erna som berörs plus "+N more".
- Körtid och belastning: default 1 sida, begränsad samtidighet, hårt tak 50.

## 6. Scoring

```ts
export const WEIGHTS = { availability: 20, security: 40, seo: 20, html: 20 } as const;
// M7: html ersätts av accessibility och vikterna räknas om, förslag
// { availability: 15, security: 35, seo: 20, accessibility: 30 } (summa 100).
// Vikterna är fortfarande preliminära; golden-testet och README uppdateras i samma commit.
export const GRADES = [
  { min: 90, label: 'Excellent' },
  { min: 75, label: 'Good' },
  { min: 50, label: 'Needs improvement' },
  { min: 0, label: 'Poor' },
] as const;
```

- Kategori-score = `sum(points) / sum(maxPoints) * WEIGHTS[cat]` över kontroller som räknas, avrundat till heltal; kategori utan sådana kontroller ger 0. `error` och `skip` räknas inte (ett fel i SiteCheck eller en kontroll som inte gällde säger inget om sajten). Övriga kategorier skalas inte upp, så en sida som inte gick att kontrollera kan inte få högt betyg.
- Total = summa av okrundade kategoripoäng, avrundad en gång (undviker avrundningsdrift). Därför summerar de avrundade kategoripoängen inte alltid till `score` – dokumenteras i README.
- Allt (vikter, gränser, tröskelvärden för kontroller) är exporterade konstanter – inga magiska tal i kontrollerna.

## 7. CLI-kontrakt

```text
sitecheck <url> [--format text|json] [--min-score <0-100>] [--pages <1-50>] [--help] [--version]
```

`--pages` tillkommer i M8. `--pages` utanför 1–50 → exit 2. Blockerad startsida → exit 3 (se 5b).

- `normalizeUrl`: trimma; saknas `scheme://` → prefixa `https://`; `new URL()` måste lyckas och protokollet vara `http:`/`https:`, annars exit 2.
- `--format` annat än `text|json` → exit 2. `--min-score` måste vara heltal 0–100 → annars exit 2.
- Commander körs med `exitOverride()` så att parse-fel mappas till exit 2.
- Rapport → stdout. Fel/diagnostik → stderr. Exit: 0 ok, 1 score < `--min-score`, 2 användarfel, 3 onåbar/internt fel.
- `--version` läser version från `package.json` (samma värde som i `User-Agent`).

## 8. Milstolpar

Varje milstolpe = en feature-branch, flera små commits, klart när "Klart när" är uppfyllt. Bocka av löpande.

### M1 – 1: Grund, kontrakt, availability

Branch: `feature/scaffold`, sedan `feature/availability`.

- [x] Kontrollera paketnamn på npm (fallback: scoped paket) och sätt `name` därefter
- [x] `package.json` med scripts `build`, `dev`, `test`, `lint`, `format`, `bin: { sitecheck }`, `engines: node >=22`
- [x] `tsconfig.json` (strict, `NodeNext`, outDir `dist`), `.gitignore`, `.prettierrc`, ESLint flat config, `vitest.config.ts`, `LICENSE` (MIT)
- [x] `checks/types.ts`, `checks/run.ts` (`makeResult`, `safeRun`)
- [x] `index.ts`: minimal `analyze(url)` (hämta → availability-kontroller); utökas i varje milstolpe så att orkestreringen aldrig hamnar i `src/cli/`
- [x] `net/http.ts`: `fetchPage` (manuell redirect-loop, timeout via `AbortController`, strömmad body med tak, lowercase-headers, mätning enligt avsnitt 2) och typade fel (`TimeoutError`, `TooManyRedirectsError`, `NetworkError`)
- [x] `checks/availability.ts`: `http-status`, `response-time`
- [x] `cli/url.ts`, `cli/index.ts` (minimal, med `--help`, `--version` och shebang `#!/usr/bin/env node`), `cli/exit-codes.ts`, `output/terminal.ts` (enkel version)
- [x] `tests/helpers/test-server.ts` (Node `http`, konfigurerbara rutter: status, headers, fördröjning, redirect-kedjor, stor body)
- [x] Tester: `url.test.ts` (inkl. `localhost:1` → `https://localhost:1`, där `new URL()` annars tolkar `localhost:` som schema), `availability.test.ts`, `http.test.ts` (timeout, redirect-tak, body-tak, redirect över schema, onåbar port)

Klart när: `npm run dev -- https://example.com` skriver Availability-sektionen; `npm test` grönt; `sitecheck localhost:1` → exit 3.

### M2 – 2: Security

Branch: `feature/security-checks`.

- [x] `checks/security.ts`: en exporterad ren funktion per kontroll (`checkHsts(headers, finalUrl)` m.fl.) + `runSecurityChecks(page)`
- [x] Parser för HSTS (`max-age`, `includeSubDomains`) och CSP-direktiv, båda egna rena hjälpfunktioner
- [x] `net/http.ts`: `probeHttpRedirect` (följer `http://`→`http://`-redirects); `https-redirect` i availability
- [x] `tests/security.test.ts` med header-fixtures: saknas, giltigt, ogiltigt/malformat värde, versaler/gemener, flera direktiv
- [x] `https-redirect`: pass/warn/fail i `availability.test.ts`, `probeHttpRedirect` mot testservern i `http.test.ts`
- [x] `remediation`-texter för alla fail/warn

Klart när: alla sex säkerhetskontroller + redirect syns i terminal-output och har tester för pass/warn/fail.

### M3 – 3: SEO och HTML

Branch: `feature/seo-html-checks`.

- [x] Parsa HTML en gång med Cheerio i orkestreringen; kontroller får `$` som indata
- [x] `checks/seo.ts`: `title`, `meta-description`, `h1`, `canonical-url`
- [x] `net/http.ts`: `fetchText(url, opts)` för `robots.txt`/`sitemap.xml` (egna tak); `robots-txt`, `sitemap-xml` (inkl. `Sitemap:`-direktiv)
- [x] `checks/html.ts`: `html-lang`, `viewport-meta`, `image-alt`, `heading-structure`
- [x] `tests/seo.test.ts`, `tests/html.test.ts` med fixtures: bra sida, dålig sida, tom/trasig HTML, icke-HTML-svar

Klart när: full rapport (alla fyra kategorier) mot lokal testserver och minst en riktig sajt.

### M4 – 4: Scoring, output, felhantering

Branch: `feature/scoring-output`.

- [x] `scoring/score.ts` + `tests/scoring.test.ts`: 0, 100, gränser 49/50/74/75/89/90, bara `error`, tom kategori, avrundning
- [x] `index.ts`: `analyze(url)` returnerar fullständig `Report` (hämta en gång → kontroller → scoring); klocka injicerbar för deterministiska tester
- [x] `output/terminal.ts`: grupperat per kategori, ✓/⚠/✗, remediation under varje icke-pass, summering + betyg, respekterar `NO_COLOR` och icke-TTY
- [x] `output/json.ts` enligt `Report`; golden-test mot fixture (fast `analyzedAt` via injicerad klocka, `responseTimeMs` normaliseras i testet)
- [x] CLI: `--format`, `--min-score`, exit codes, felmeddelanden på stderr
- [x] Felhantering: onåbar → exit 3 med läsbart meddelande; oväntat undantag → exit 3, stacktrace bara med `DEBUG=sitecheck`

Klart när: `--format json | jq .` fungerar, alla exit codes i avsnitt 7 verifierade av tester.

### M5 – 5: Kvalitet och CI

Branch: `feature/quality-ci`.

- [x] `tests/cli.integration.test.ts`: bygg CLI:t, kör mot lokal testserver (bra sajt, dålig sajt, 404, långsam, redirect-loop → exit 3, stängd port → exit 3); kontrollera stdout, stderr och exit code
- [x] Granska täckning, städa lint/format
- [x] `.github/workflows/ci.yml`: Node 22 och 24; `npm ci`, `lint`, `build`, `test`
- [x] README (installation, användning, scoremodell inkl. avrundning, JSON-schema, response-time-definition, begränsningar)
- [x] Manuell testrunda mot 5–10 riktiga sajter (dokumentera avvikelser, justera trösklar)

Klart när: CI grön på PR, README beskriver allt CLI:t gör.

**Täckning (2026-10-23):** 96,8 % rader, 92,0 % grenar för `src/`. Det som återstår är defensiva grenar (ogiltig redirect-`Location`, cheerio-parsefel) och `src/cli/index.ts`, som bara körs som subprocess i integrationstesterna. `@vitest/coverage-v8` är inte tillagt som beroende: `npm i` på Windows med npm 11.6 tar bort rolldowns plattformsbinärer ur lockfilen (npm/cli#4828), så rapporten togs fram i en separat worktree.

**Manuell testrunda (2026-10-23)**, `SiteCheck/0.1.0`, inga trösklar ändrade:

| Sajt              | Score | Kommentar                                                                                |
| ----------------- | ----: | ---------------------------------------------------------------------------------------- |
| github.com        |    92 |                                                                                          |
| x.com             |    91 | SPA – HTML/SEO bedöms på skalet, ingen JS-rendering (känd begränsning)                   |
| mozilla.org       |    89 |                                                                                          |
| svt.se            |    86 | 63 `<h1>` → warn, HSTS max-age 90 dagar → warn                                           |
| nodejs.org        |    83 | Saknar CSP, Referrer-Policy, Permissions-Policy                                          |
| reddit.com        |    73 | 200 med 8 kB bot-skal (title "Reddit", inga rubriker) – SEO/HTML bedömer skalet          |
| bbc.com           |    72 |                                                                                          |
| wikipedia.org     |    67 | sitemap.xml ger 403 för vår UA; title "Wikipedia" (9 tecken) → warn                      |
| stackoverflow.com |    60 | 403 + Cloudflare-challenge; robots.txt ger 418. SEO/HTML bedömer challenge-sidan         |
| example.com       |    44 | Minimal sida utan säkerhetsheaders, väntat lågt                                          |

Avvikelser (status efter M5): sidkontrollerna hoppas över (`skip`) när sidan inte svarar 2xx (avsnitt 5), så blocksidor som stackoverflow.com får bara availability/security/robots/sitemap bedömda. Bot-skal som svarar 200 (reddit.com) bedöms som de levereras. Dokumenterat i README under Limitations. M6 ersätter 401/403/429- och challenge-fallet med "access not allowed".

### M6 – Blockerade sajter

Branch: `feature/blocked-sites`. Beslut 2026-10-28: ska med före release.

- [x] `checks/blocked.ts`: `detectBlock(page, robots)` + konstanter för challenge-mönster (se 5b)
- [x] `BlockedError` i `checks/blocked.ts`, re-export från `index.ts`; `analyze()` kastar den för blockerad startsida (robots.txt hämtas före kontrollerna)
- [x] `cli/exit-codes.ts`: kommentar på `EXIT_UNREACHABLE` att 3 även betyder blockerad (namnet behålls)
- [x] `availability.ts`: ta bort 401/403/429-hinten ur `http-status` (fallet når inte längre kontrollen)
- [x] CLI: `Access not allowed: <orsak>` på stderr, inget på stdout, exit 3
- [x] Tester: `detectBlock` per reason med header/body-fixtures, 401/403/429/challenge/robots-disallow mot testservern, att 404/5xx fortfarande ger vanlig rapport, CLI-integrationstest (stdout tomt, stderr innehåller orsak, exit 3)
- [x] README (Limitations, exit codes) och manuell test mot en sajt som blockerar (t.ex. stackoverflow.com, som tidigare gav 403)

Klart när: en blockerad sajt ger ett tydligt "access not allowed" med orsak i stället för en score.

### M7 – Accessibility (WCAG)

Branch: `feature/a11y-checks`, därefter `feature/a11y-category`.

- [ ] `checks/accessibility.ts`: checkarna i 5c som rena funktioner + `runAccessibilityChecks`
- [ ] `wcag?: string[]` på `CheckDefinition`/`CheckResult`; visas i terminal och JSON
- [ ] Ny kategori `accessibility` som ersätter `html`: flytta `html-lang`, `image-alt`, `heading-structure` hit och `viewport-meta` till `seo`; ta bort `html` ur `Category`; nya `WEIGHTS` (se avsnitt 6)
- [ ] `checks/html.ts` upphör; kontrollerna flyttas till `accessibility.ts` resp. `seo.ts`, testerna likaså
- [ ] Tester med bra/dåliga fixtures per check, inkl. kantfall (`alt` i länk, omslutande label, dolda fält); uppdatera `good.html`, `bad.html` och golden-JSON
- [ ] Scoring-tester för den nya kategorin; README (checks, score-modell, begränsningar: ingen kontrast/fokus)
- [ ] Fas B om tid finns: tabellrubriker, `autocomplete`, autoplay

Klart när: rapporten har en accessibility-sektion med WCAG-referenser, och `npm test` är grönt.

### M8 – Flera sidor via sitemap

Branch: `feature/sitemap-reader`, därefter `feature/multi-page`. Kan göras före M7.

- [ ] `net/http.ts`: `fetchBytes()` (rå `Buffer` + `truncated`) + tester
- [ ] `net/sitemap.ts`: parsning av urlset/sitemapindex, gzip med storlekstak, tak på antal sitemaps och URL:er, same-origin-filter, robots.txt-filter (se 5d)
- [ ] `samplePages()`: deterministiskt urval grupperat på path-segment
- [ ] Refaktorera `analyze()`: `analyzePage()` för per-sida-kontroller, orkestrering med samtidighetstak 4
- [ ] `aggregate.ts` + `pages`/`meta.pagesAnalyzed` i `Report`
- [ ] CLI: `--pages <n>` (validering, exit 2), stderr-notis när sitemap saknas, terminal visar berörda URL:er
- [ ] Tester: sitemap-parser (index, gzip, zip-bomb, andra hosts), urval, aggregering (alla pass / blandat / alla fail / skippade), integrationstest mot testserver med 3 sidor och en blockerad sida

Klart när: `sitecheck <url> --pages 10` analyserar flera sidor, och `--pages 1` ger samma rapport som idag.

### M9 – Release

Branch: `release/1.0.0`. Ett mål, inte en deadline: görs när M6 och helst M7–M8 är klara, annars kan 1.0.0 släppas utan M7–M8.

- [ ] Bekräfta att paketnamnet från M1 fortfarande är ledigt
- [ ] `package.json`: `files: ["dist"]`, `bin`, verifiera shebang i `dist/cli/index.js`, `repository`, `keywords`, `license`
- [ ] `npm pack` → installera tarball i tom katalog → `npx sitecheck https://example.com`
- [ ] `CHANGELOG.md`, exempel-output i README
- [ ] Tagga `v1.0.0`, `npm publish`

Klart när: paketet kan köras med `npx` från registret på ren maskin.

## 9. Testmatris

| Nivå        | Vad                                                                  | Nätverk         |
| ----------- | -------------------------------------------------------------------- | --------------- |
| Enhet       | Varje kontroll som ren funktion, scoring, URL-normalisering, parsers | Nej (fixtures)  |
| Modul       | `net/http.ts` mot lokal testserver                                   | Bara localhost  |
| Integration | Byggt CLI mot lokal testserver, exit codes och stdout/stderr         | Bara localhost  |
| Manuell     | Riktiga sajter inför release                                         | Ja, aldrig i CI |

## 10. Risker och hur de hanteras

| Risk                                                | Åtgärd                                                                                  |
| --------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Sajter som blockerar okänd `User-Agent` / bot-skydd | Tydlig UA; blockering upptäcks och rapporteras som "access not allowed" med orsak (M6), vi kringgår aldrig skyddet |
| Flera sidor ger last/lång körtid, elak sitemap      | Default 1 sida, tak 50, samtidighet 4, same-origin + robots.txt-filter, storlekstak på sitemap/gzip (M8) |
| SPA:er där innehållet renderas klientsidigt         | Dokumentera som begränsning (ingen JS-rendering); HTML-kontroller körs på serverns HTML |
| Enorma/felaktiga svar                               | Body-tak, timeout, `truncated`-flagga, Cheerio körs bara på kapad body                  |
| Poäng upplevs orättvisa                             | Vikter och trösklar som konstanter; justeras efter manuell testrunda (M5)               |
| Paketnamnet `sitecheck` upptaget                    | Kontrolleras tidigt i M1, inte först i M6                                               |
| Framtida SSRF vid REST API                          | Allt nätverk i `net/http.ts` – ett ställe att lägga blockering av privata adresser      |

## 11. Utanför scope (v1.0.0)

Performance (page size, Core Web Vitals, cache), REST API, GitHub Action, JS-rendering.

Flyttat in i scope 2026-10-28 (M6–M8): blockeringsdetektering, statiska WCAG-kontroller och flera sidor via sitemap. Fortfarande utanför: kontrast, fokus- och tangentbordskontroller (kräver headless browser), egen länk-crawling utan sitemap.
