# CLAUDE.md

Vägledning för Claude Code i det här repot. Produktspecifikationen finns i [SiteCheck.md](SiteCheck.md) – läs den för funktionslista, roadmap och exempel på output.

## Projekt

SiteCheck är ett CLI-verktyg (TypeScript/Node.js) som tar en URL, kör automatiserade kontroller inom Availability, Security, SEO och HTML, och presenterar en rapport med en score 0–100.

**Status:** Repot innehåller i nuläget bara specifikationen – ingen kod, `package.json` eller tester finns ännu. Följ roadmapen i SiteCheck.md (vecka 1 först: TypeScript-projekt, CLI, HTTP-request, status och response time). Uppdatera kommandona nedan när de faktiskt finns.

## Kommandon

Förväntade npm-scripts (skapa dem med exakt dessa namn när projektet sätts upp):

```bash
npm run build        # tsc
npm run dev -- https://example.com   # kör CLI:t från källkod
npm test             # Vitest
npx vitest run tests/security.test.ts   # ett enskilt test
npm run lint         # ESLint
npm run format       # Prettier
```

## Arkitektur

Två lager med en strikt gräns:

- **CLI-lager** (`src/cli/`): argumentparsning (Commander), val av output-format, exit codes. Ingen affärslogik.
- **Analysmotor** (`src/checks/`, `src/scoring/`): ren logik som kan återanvändas i en framtida GitHub Action, REST API eller webbgränssnitt. **Får aldrig importera något från `src/cli/` eller skriva till stdout/stderr.** Motorn returnerar data; `src/output/` (`terminal.ts`, `json.ts`) renderar den.

Flöde: CLI → hämta sidan en gång → kör kontroller → scoring → output.

### Designregler

- **Hämta sidan en gång.** Availability-kontrollen gör huvudanropet; HTML-, SEO- och header-kontroller får svar/HTML som indata istället för att göra egna anrop. Endast `robots.txt`, `sitemap.xml` och HTTP→HTTPS-redirect kräver extra requests.
- **Gemensamt check-gränssnitt.** Varje kontroll returnerar ett strukturerat resultat, t.ex. `{ id, category, status: 'pass' | 'warn' | 'fail', message, remediation?, points }`. Terminal- och JSON-output byggs från samma resultatlista. `remediation` behövs för målet "ge information om hur problem kan åtgärdas".
- **Kontroller ska vara rena funktioner** där det går (indata: headers/HTML/status, utdata: resultat) så att de kan enhetstestas utan nätverk.
- **En kontroll som kraschar får inte krascha hela körningen.** Fånga fel per kontroll och rapportera den som `fail`/`error`.
- **Scoring** ligger helt i `src/scoring/score.ts`. Viktningarna i specen (Availability 20, Security 40, SEO 20, HTML 20) är preliminära – håll dem som konstanter på ett ställe. Betygsgränser: 90–100 Excellent, 75–89 Good, 50–74 Needs improvement, 0–49 Poor.

## CLI-kontrakt

- `sitecheck <url> [--format text|json] [--min-score <n>]`, plus `--help` och `--version`.
- Exit codes (definiera som konstanter): `0` ok, `1` score under `--min-score`, `2` ogiltig input/användarfel, `3` webbplatsen kunde inte nås eller internt fel.
- Resultat skrivs till **stdout**, felmeddelanden och diagnostik till **stderr**, så att `--format json` alltid går att pipa.
- Om URL saknar schema: anta `https://`.
- JSON-outputen är ett publikt gränssnitt. Den ska innehålla `url`, `score`, betyg, per-kategori-score och en lista med checks (id, status, message) – inte bara booleans som exemplet i specen – och ändringar ska göras medvetet.

## Robusthet och säkerhet

- Sätt alltid timeout på HTTP-anrop (förslag: 10 s) och begränsa antal redirects.
- Begränsa hur mycket av svarskroppen som läses (HTML-parsning av enorma svar ska inte kunna hänga processen).
- Skicka en tydlig `User-Agent` (`SiteCheck/<version>`).
- Behandla all hämtad data som otillförlitlig. Om analysmotorn senare exponeras via ett REST API måste SSRF hanteras (blockera privata/loopback-adresser) – håll nätverksanropen bakom en enda modul så det går att lägga till.
- Mät response time konsekvent (tid till första svar, inte inkl. HTML-parsning) och dokumentera definitionen.

## Kodstil

- TypeScript i strikt läge (`"strict": true`), ESM.
- Prettier och ESLint är källan till sanning för formatering – diskutera inte stil i kod.
- Namngivning: kontroll-id i kebab-case (`content-security-policy`), filer i lowercase.
- Inga nya beroenden utan anledning; Node:s inbyggda `fetch` räcker troligen istället för axios/node-fetch. Cheerio för HTML-parsning.
- Språk: användarvända texter (CLI-output) på engelska enligt exemplen i specen. Projektdokumentation och diskussion kan vara på svenska.

## Tester

- Enhetstester per kontrollmodul i `tests/`, utan riktigt nätverk (mocka/fixtures för headers och HTML).
- Testa scoring separat, inklusive gränsfall (0, 100, betygsgränser).
- Integrationstester av CLI:t körs mot en lokal testserver, inte mot riktiga webbplatser. Manuell testning mot riktiga sajter sker separat.
- Lägg till eller uppdatera tester när en kontroll läggs till eller ändras.

## Utanför scope för v1.0.0

Performance (page size, Core Web Vitals, cache), fler WCAG-/ARIA-kontroller, REST API och GitHub Action. Bygg inte detta nu, men håll analysmotorn ren så att det går att lägga till senare.

## Git

- Arbeta på feature-branches, inte direkt på `main`.
- Små, fokuserade commits; en kontroll eller ett steg i roadmapen per commit/PR när det är rimligt.
- Licens: MIT.
