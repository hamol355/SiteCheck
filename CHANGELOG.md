# Changelog

## Unreleased

### Added

- Security: `tls-certificate`, `clickjacking`, `cookie-flags`, `mixed-content`, `subresource-integrity`, `form-action-https`, `info-disclosure`, `cross-origin-isolation`, `security-txt`.
- SEO: `indexable`, `open-graph`, `structured-data`, `hreflang`, `charset`, `doctype`, `duplicate-titles`, `duplicate-descriptions`; `canonical-url` now warns when the canonical points to another origin.
- Availability: `soft-404` (one extra request to a random path), `redirect-chain`, `www-consistency` (one extra request).
- Accessibility: `html-lang-valid`, `empty-heading`, `skip-link`, `list-structure`, `duplicate-id`; `image-alt` also covers `input[type=image]`, `<area href>` and `svg[role=img]`.

### Changed

- **Scores change.** The new checks raise the maximum points of their categories. Category weights are unchanged and the category score is normalised against them, so the same site can get a somewhat different score than before.
