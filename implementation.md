# Implementationsplan – SiteCheck v1.0.0

Det här dokumentet bryter ner roadmapen i [SiteCheck.md](SiteCheck.md) till konkreta steg. Regler och konventioner finns i [CLAUDE.md](CLAUDE.md); vid konflikt gäller CLAUDE.md.

## 1. Avvikelser från roadmapen i specen

| Spec                                         | Här                                                          | Varför                                                     |
| -------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------- |
| JSON: `checks` är en bool-map                | JSON: `checks` är en lista med id/status/message/remediation | Publikt gränssnitt som ska tåla nya kontroller (CLAUDE.md) |
| "Saknad `<title>`" listas under HTML och SEO | En enda `title`-kontroll i SEO                               | Undviker dubbelräkning                                     |
| "Om webbplatsen går att nå" som kontroll     | Onåbar sida avbryter körningen med exit code 3               | Det går inte att ge en meningsfull score utan svar         |

## 2. Beslut som gäller genom hela projektet

- **Node 22 LTS+** (Node 20 är EOL sedan april 2026), ESM (`"type": "module"`), TypeScript `strict`.
- **Beroenden:** runtime `commander`, `cheerio`; dev `typescript`, `vitest`, `eslint` (+ `typescript-eslint`), `prettier`, `tsx`. Ingen axios/node-fetch.
- **Response time** = tid från att sista requesten skickas tills svarshuvudena tagits emot (kan inkludera DNS/TLS – vid redirect till samma host återanvänder `fetch`/undici anslutningen och då ingår de inte; exkl. redirects före den, body-läsning och parsning). Dokumenteras i kod och README.
- **Nätverk** sker bara i `src/net/http.ts`: timeout 10 s (5 s för robots/sitemap), max 5 redirects (manuell loop, bara `http:`/`https:`), body-tak 2 MB (1 MB för robots/sitemap), `User-Agent: SiteCheck/<version>`.
- **Motorn** (`src/checks`, `src/scoring`, `src/net`, `src/index.ts`) importerar aldrig `src/cli` och skriver aldrig till stdout/stderr.

## 3. Målstruktur

```text
src/
  cli/index.ts          # Commander, flaggor, mappning fel → exit code
  cli/exit-codes.ts     # EXIT_OK=0, EXIT_BELOW_MIN_SCORE=1, EXIT_USAGE=2, EXIT_UNREACHABLE=3
  cli/url.ts            # normalizeUrl()
  net/http.ts           # fetchPage(), fetchText(), probeHttpRedirect()
  checks/types.ts       # CheckResult, Category, Status, CheckDefinition
  checks/run.ts         # safeRun(), runChecks()
  checks/availability.ts
  checks/security.ts
  checks/seo.ts
  checks/html.ts
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

Poäng per status: `pass` = maxPoints, `warn` = hälften (avrundat nedåt), `fail`/`error` = 0. `error`-kontroller räknas dock inte alls i scoring (se avsnitt 6). Helper `makeResult(def, status, message, remediation?)` räknar ut `points` så att kontroller aldrig hanterar poäng själva.

`safeRun(def, fn)` fångar alla undantag och returnerar `status: 'error'` med meddelandet "Check failed to run: …". En kraschande kontroll påverkar inte övriga, och CLI:t skriver en varning till stderr.

## 5. Kontrollkatalog

Poängen är relativa inom kategorin; kategorin normaliseras mot sin vikt (20/40/20/20), se avsnitt 6. Summan per kategori är satt till vikten så att råpoäng = slutpoäng.

### Availability (20)

| id               | max | pass                                                                  | warn                                                                   | fail                                 |
| ---------------- | --- | --------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------ |
| `http-status`    | 8   | slutlig status 2xx                                                    | 3xx som inte följts (utan `Location`, 300, 304 …)                      | 4xx/5xx                              |
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

## 6. Scoring

```ts
export const WEIGHTS = { availability: 20, security: 40, seo: 20, html: 20 } as const;
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
sitecheck <url> [--format text|json] [--min-score <0-100>] [--help] [--version]
```

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

Avvikelser: blockerade sajter (403 eller reducerat bot-svar) får SEO/HTML bedömt på blocksidan. Dokumenterat i README under Limitations. Ändrat efter granskningen (före v1.0.0): sidkontrollerna hoppas nu över (`skip`) när sidan inte svarar 2xx, se avsnitt 5. Bot-skal som svarar 200 bedöms fortfarande som de levereras.

### M6 – 6: Release

Branch: `release/1.0.0`.

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
| Sajter som blockerar okänd `User-Agent` / bot-skydd | Tydlig UA; 403 rapporteras som `http-status` fail med hint i remediation                |
| SPA:er där innehållet renderas klientsidigt         | Dokumentera som begränsning (ingen JS-rendering); HTML-kontroller körs på serverns HTML |
| Enorma/felaktiga svar                               | Body-tak, timeout, `truncated`-flagga, Cheerio körs bara på kapad body                  |
| Poäng upplevs orättvisa                             | Vikter och trösklar som konstanter; justeras efter manuell testrunda (M5)               |
| Paketnamnet `sitecheck` upptaget                    | Kontrolleras tidigt i M1, inte först i M6                                               |
| Framtida SSRF vid REST API                          | Allt nätverk i `net/http.ts` – ett ställe att lägga blockering av privata adresser      |

## 11. Utanför scope (v1.0.0)

Performance (page size, Core Web Vitals, cache), fler WCAG/ARIA-kontroller, REST API, GitHub Action, JS-rendering.
