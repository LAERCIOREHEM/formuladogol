# FDG-UX-HF2 — Match Experience, Agenda Unification & Editorial Game Cards

Stacked on certified HF1 (5931985f). PR targeting main includes HF1 until #75 merges; no merge or public deploy without explicit authorization.

## Contract
- Games: responsive editorial cards with large crests, distinct score/fixture and AF 1.3 preview values, immediately visible attendance and gate receipts, summary of available scorers, verified highlights, original canonical details, 12-card pagination and existing filters. Missing data remain explicit; no estimated attendance or revenue.
- Agenda and match detail: remove decorative legacy masthead, keep one global navigation, preserve original scripts, canonical/JSON-LD, match hero, operational statistics, alert slots, transmission actions and agenda filters; align responsive color and scale with the SL02 design.
- Media: use the archived match identity and exact score; only valid canonical YouTube ID and URL accepted. Embed only on user click when embeddable is explicitly true. Otherwise show the archived external URL or an explicitly labeled YouTube search. Never autoplay before user action or issue provider API requests.
- Match facts: generate a compact presentation-only projection from already-public jogos-detalhes.json with source SHA-256. If manifest has a newer digest, refresh from the existing hash-verified public source; missing optional media/stats never prevent displaying scores or forecasts. No new data source, changed worker, push, AF inputs or schedule.
- Tests: full HF1 regression preserved; all final canonical pages validate exact source facts and media state; browser matrix covers 7 widths and 2 themes on next, results, agenda and representative canonical details; explicit embed/link/search and filters; preview CSP blocks external playback, so test asserts DOM/player URL, not third-party video availability. Production smoke reads only public FDG sources.

## HF2-R1 — desktop artwork and official media only
Desktop artwork fills the available masthead width; mobile and live density retained. Missing official highlights now show a neutral pending state, never generic YouTube search. Existing API workflow, source policy, quotas and data files untouched. Only exact archived URLs and explicit embedding permission are presented.

Restore the original manual-over-automatic highlights precedence, including exact archived URLs with timestamps. Test pending state with a local fixture even if all real finals have media.

Desktop probability density: explicitly override the earlier more-specific club column, size chips at 72px with 3px vertical padding, limit comparative scroll region to 1280px, and assert 20 unbroken club names, 140 fitting chips, measured row/chip dimensions, and no document overflow at 1024, 1280, 1440, 1600 and 1920px in both themes. Mobile unchanged.
