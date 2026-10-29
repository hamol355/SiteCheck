# Changelog

## Unreleased

### Added

- Security: `tls-certificate`, `clickjacking`, `cookie-flags`, `mixed-content`.
- SEO: `indexable`.
- Availability: `soft-404` (one extra request to a random path).
- Accessibility: `html-lang-valid`.

### Changed

- **Scores change.** The new checks raise the maximum points of their categories. Category weights are unchanged and the category score is normalised against them, so the same site can get a somewhat different score than before.
