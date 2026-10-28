# SiteCheck

SiteCheck är ett CLI-verktyg som snabbt analyserar en webbplats och hittar vanliga problem inom tillgänglighet (availability), säkerhet, SEO och teknisk webbstandard.

Målet är att ge utvecklare en snabb och lättförståelig rapport över vad som fungerar bra och vad som kan förbättras.

> **Status:** 🚧 Under utveckling. Första stabila version (v1.0.0) planeras efter en sexveckorsperiod.

## Exempel

```bash
sitecheck https://example.com
```

```text
SiteCheck
────────────────────────────────────────

URL: https://example.com

Availability
✓ HTTP status: 200
✓ Response time: 184 ms

Security
✓ HTTPS enabled
✓ Strict-Transport-Security
✓ X-Content-Type-Options
✗ Content-Security-Policy

SEO
✓ Page title
✓ Meta description
✓ robots.txt
✗ sitemap.xml

HTML
✓ lang attribute
✓ viewport meta tag
⚠ 3 images missing alt attributes

────────────────────────────────────────
Score: 82/100
```

## Problem

När man utvecklar och publicerar en webbplats är det lätt att missa små men viktiga detaljer, till exempel:

- Saknade security headers
- Dåligt konfigurerad HTTPS
- Saknad `robots.txt`
- Saknad eller dålig meta description
- Bilder utan `alt`
- Saknat `lang`-attribut
- Långsamma svarstider
- Felaktiga HTTP-statuskoder

Det finns många avancerade verktyg för att analysera webbplatser, men SiteCheck fokuserar på att vara enkelt, snabbt och användbart direkt från terminalen.

## Mål

Projektet ska erbjuda ett CLI-verktyg som:

1. Tar emot en URL
2. Analyserar webbplatsen
3. Kör ett antal automatiserade kontroller
4. Presenterar resultatet tydligt
5. Ger en sammanfattande score
6. Ger information om hur problem kan åtgärdas

## Funktioner

### Availability

- HTTP-statuskod
- Svarstid
- Om webbplatsen går att nå
- HTTP → HTTPS-redirect

```text
Availability
✓ HTTP status: 200
✓ Response time: 184 ms
```

### Security

- HTTPS
- `Strict-Transport-Security`
- `Content-Security-Policy`
- `X-Content-Type-Options`
- `Referrer-Policy`
- `Permissions-Policy`

```text
Security
✓ HTTPS
✓ HSTS
✓ X-Content-Type-Options
✗ Content-Security-Policy
```

### SEO

- `<title>`
- Meta description
- `<h1>`
- `robots.txt`
- `sitemap.xml`
- Canonical URL

```text
SEO
✓ Title
✓ Meta description
✓ robots.txt
✗ sitemap.xml
```

### HTML

- `lang`-attribut
- Viewport meta tag
- Bilder utan `alt`
- Saknad `<title>`
- Grundläggande heading-struktur

## Installation

När projektet är publicerat som npm-paket kan det installeras globalt:

```bash
npm install -g sitecheck
```

Eller köras direkt utan installation:

```bash
npx sitecheck https://example.com
```

> Paketnamnet kan komma att ändras beroende på tillgänglighet.

## Användning

```bash
# Analysera en webbplats
sitecheck https://example.com

# JSON-output (för scripts och CI/CD)
sitecheck https://example.com --format json

# Misslyckas med non-zero exit code om scoren understiger 80
sitecheck https://example.com --min-score 80

# Visa hjälp
sitecheck --help

# Visa version
sitecheck --version
```

### JSON-output

```json
{
  "url": "https://example.com",
  "score": 82,
  "checks": {
    "https": true,
    "hsts": true,
    "contentSecurityPolicy": false,
    "robotsTxt": true,
    "sitemap": false
  }
}
```

## Score

Varje webbplats får en score mellan 0 och 100.

| Score  | Betyg             |
| ------ | ----------------- |
| 90–100 | Excellent         |
| 75–89  | Good              |
| 50–74  | Needs improvement |
| 0–49   | Poor              |

Scoren baseras på resultaten från de olika kontrollerna:

| Kategori     | Poäng      |
| ------------ | ---------- |
| Availability | 20/20      |
| Security     | 30/40      |
| SEO          | 18/20      |
| HTML         | 14/20      |
| **Totalt**   | **82/100** |

> Exakta viktningar kan komma att ändras under utvecklingen.

## Arkitektur

Projektet är uppdelat i ett CLI-lager och en separat analysmotor.

```text
┌──────────────────────────────┐
│         CLI Interface        │
│                              │
│       sitecheck <url>        │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│        Analysis Engine       │
│                              │
│  ┌──────────┐  ┌──────────┐  │
│  │ Security │  │   SEO    │  │
│  └──────────┘  └──────────┘  │
│  ┌──────────┐  ┌──────────┐  │
│  │   HTML   │  │ Availab. │  │
│  └──────────┘  └──────────┘  │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│       Result / Scoring       │
└──────────────────────────────┘
```

En viktig designprincip är att analysmotorn är separerad från CLI:t. Det gör det möjligt att senare återanvända den i exempelvis:

- Ett webbgränssnitt
- Ett REST API
- En GitHub Action
- Andra CLI-verktyg

## Teknisk stack

- TypeScript
- Node.js
- Commander (eller liknande CLI-ramverk)
- Cheerio för HTML-parsning
- Vitest eller Jest för tester
- ESLint
- Prettier
- GitHub Actions

> Exakt teknikstack kan ändras under utvecklingen.

## Projektstruktur

En möjlig struktur:

```text
sitecheck/
├── src/
│   ├── cli/
│   │   └── index.ts
│   ├── checks/
│   │   ├── availability.ts
│   │   ├── security.ts
│   │   ├── seo.ts
│   │   └── html.ts
│   ├── scoring/
│   │   └── score.ts
│   ├── output/
│   │   ├── terminal.ts
│   │   └── json.ts
│   └── index.ts
├── tests/
│   ├── availability.test.ts
│   ├── security.test.ts
│   ├── seo.test.ts
│   └── scoring.test.ts
├── package.json
├── tsconfig.json
├── README.md
└── LICENSE
```

## Roadmap

### Vecka 1 – CLI och grundstruktur

- [ ] Skapa TypeScript-projekt
- [ ] Implementera CLI som tar emot URL som argument
- [ ] HTTP-request
- [ ] Kontrollera HTTP-status
- [ ] Mäta response time
- [ ] Grundläggande terminal-output

### Vecka 2 – Security checks

- [ ] HTTPS
- [ ] HSTS
- [ ] Content-Security-Policy
- [ ] X-Content-Type-Options
- [ ] Referrer-Policy
- [ ] Permissions-Policy

### Vecka 3 – SEO och HTML

- [ ] Page title
- [ ] Meta description
- [ ] H1
- [ ] `robots.txt`
- [ ] `sitemap.xml`
- [ ] Canonical URL
- [ ] HTML `lang`
- [ ] Viewport
- [ ] Bildkontroll

### Vecka 4 – Scoring och output

- [ ] Score 0–100
- [ ] Kategorispecifika scores
- [ ] Förbättrad terminal-output
- [ ] JSON-output
- [ ] Exit codes
- [ ] Felhantering

### Vecka 5 – Kvalitet och CI

- [ ] Unit tests
- [ ] Integration tests
- [ ] ESLint
- [ ] Prettier
- [ ] GitHub Actions
- [ ] Dokumentation
- [ ] Testa mot riktiga webbplatser

### Vecka 6 – Blockering, tillgänglighet och flera sidor

Tillagt 2026-10-28, före release. Detaljer i [implementation.md](implementation.md) (M6–M8).

- [ ] Blockerade sajter: tydligt "access not allowed" med orsak i stället för score
- [ ] Statiska WCAG-kontroller (länk-/knappnamn, formulärfält, iframe-titel, landmarks, ARIA, zoom, tabindex, meta refresh)
- [ ] Ny kategori `accessibility` som ersätter `html` (`viewport-meta` flyttas till SEO)
- [ ] Analysera fler sidor via sitemap (`--pages`)

### Vecka 7 – Release

Ett mål, inte en deadline.

- [ ] Publicera npm-paket
- [ ] Förbättra README
- [ ] Dokumentera CLI-kommandon
- [ ] Skapa exempel
- [ ] Slutlig testning
- [ ] Release v1.0.0

## Framtida funktioner

Ingår inte i den första versionen men kan implementeras senare.

**Performance**

- Page size
- Antal requests
- Compression
- Cache headers
- Core Web Vitals

**Accessibility**

- Kontrastkontroller, fokusindikator och tangentbordsfällor (kräver headless browser)

Statiska WCAG-kontroller (formulärfält, ARIA m.m.) är flyttade till vecka 6.

**Flera sidor**

- Länk-crawling utan sitemap (analys av sidor ur sitemap är flyttad till vecka 6)

### CI/CD

SiteCheck ska kunna användas direkt i ett GitHub Actions-workflow:

```yaml
- name: Check website
  run: npx sitecheck https://example.com --min-score 80
```

Om webbplatsens score understiger gränsvärdet returnerar CLI:t en non-zero exit code, vilket låter CI-jobbet misslyckas.

### REST API

Analysmotorn skulle senare kunna exponeras via ett REST API.

`POST /api/analyze`

Request:

```json
{
  "url": "https://example.com"
}
```

Response:

```json
{
  "score": 82,
  "categories": {
    "availability": 20,
    "security": 30,
    "seo": 18,
    "html": 14
  }
}
```

## Begränsningar

SiteCheck är inte tänkt att ersätta professionella säkerhetsverktyg, penetrationstester eller fullständiga SEO- och accessibility-analyser.

Resultaten är automatiserade rekommendationer och grundläggande kontroller, inte en garanti för att en webbplats är säker eller korrekt.

## Målgrupp

- Webbutvecklare
- Studenter
- Hobbyutvecklare
- Små utvecklingsteam
- Projekt som vill ha enkla automatiserade webbkontroller

## Licens

Projektet använder [MIT License](LICENSE).
