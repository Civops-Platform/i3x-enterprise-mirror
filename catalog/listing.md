# CESMII Smart Manufacturing Catalog — listing sheet

Fields follow what the Catalog shows on every entry (catalog.cesmii.net): name, vendor, description,
tags, SM imperative, category, asset link, vendor website, images. Image URLs below assume the repo is
public at the asset link; Jonathan links them from there.

| Field | Value |
|---|---|
| Name | i3X Enterprise Mirror |
| Vendor | CivOps |
| Vendor website | https://civops.io |
| SM imperative | i3X |
| Category | Open Source |
| License | MIT |
| Asset link | https://github.com/Civops-Platform/i3x-enterprise-mirror |
| Tags | #Enterprise #MultiSite #Mirror #DataQuality #Replay #OpenSource |
| Hero image | `catalog/hero-1600x900.png` → https://raw.githubusercontent.com/Civops-Platform/i3x-enterprise-mirror/main/catalog/hero-1600x900.png |
| Image source | `catalog/src/hero.html` (rendered by `catalog/render.sh`, headless Chrome at 1600×900) |
| Vendor logo | `catalog/civops-logo-light.png` (light backgrounds), `catalog/civops-logo-dark.png` (dark), 800×192; SVG sources in `catalog/src/` |

## Description (short — the line under the title)

Mirrors any i3X 1.0 server into an enterprise view over the plain i3X client contract, keeps the site's element ids, and tells the truth about values when the uplink drops.

## Description (long)

The site does not have to know it is being mirrored. The mirror reads the site's types and objects, subscribes to all of them and holds the stream open, the same way any i3X client would, so a site server from any vendor can be mounted without changing it.

When the link to the site goes down, every mirrored value turns Uncertain and keeps its last value. It is never shown as Good, because nobody knows that, and it is never blanked, because the last value is still worth seeing. When the link comes back, the gap is replayed with ordinary i3X reads in priority order: alarms and quality first, then records, then current values, then the history backfill. An alarm that tripped and cleared while the link was down still ends up in the enterprise history, which matters to whoever has to explain the shift afterward.

Writes to a mirrored element are sent on to the site that owns it, with the caller's own credential and idempotency key, and the site decides whether to allow them. The mirror never writes with its own token.

TypeScript on Node 22, MIT licensed, no runtime dependencies. The cache, history and address-space pieces are interfaces with in-memory versions included, so it can sit inside an existing server. The tests run against a stand-in i3X site that can be taken down and brought back on the same port.
