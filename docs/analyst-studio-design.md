# Analysis Studio design and behaviour

Current contract, 18 September 2026. Implemented controls are described below;
future scope is listed separately. Release criteria remain in
[architecture](architecture.md), with work status in [implementation](implementation.md).

## One workflow, two surfaces

Chat discovers intent, explains results and proposes useful next questions.
The native dsh right sidebar handles data review, direct edits and saved work.
Both use the same managed services, published datasets and analysis revisions.
No separate analyst app, unrestricted code tool or second agent loop is added.

Open Studio from a result card or `/analyst-data`, `/analyst-explore`,
`/analyst-dashboard`, `/analyst-report`, `/analyst-reviews`. Commands do not spend
an agent turn. The harness can collapse its sidebar after reload; reopening
restores supported persisted analysis state, not an automatic window layout.

## Data: review before publication

Source cards show status and Open column review. The sidebar retrieves the full
stored proposal independently of the bounded model observation. Table selection,
column search, aligned type/format controls and sticky headers support wide
schemas. Save proposal changes before approval. Approve and Reject sit in a sticky decision footer at the bottom of the review: it
spans the card, scrolls with nothing (the grid scrolls under it), names the decision
on the left ("Approve these storage types to publish", or "Save or reset your
column changes to approve" while blocked) and keeps the primary action at the
trailing edge. With a wide schema the pair used to render below the fold, where a
first click missed it; a disabled pair now explains itself where the buttons are. Source identity, skipped files,
unknown quality and provenance warnings stay visible; missing samples are never
fabricated. Material cast failures return to an explicit publication decision.

The proposal's own warnings are listed above the grid — the same strings the model
was given (ambiguous day/month order, sample-only inference, a duplicated or blank
source label, sheet structure) — so the reason behind a type is visible where the
type is decided. Each table that has a date or timestamp column also carries a
format control: choosing the order (month first, day first, ISO, or a timestamp
form) and saving it with the type changes persists that format on the proposal, so
re-ingesting parses those values into real dates. While that choice is unsaved,
approval stays blocked exactly as it does for an unsaved type change — the format is
only applied by Save type changes, so approving with one pending would silently drop
it — and the choice is part of the session's recovery draft. Switching a format back to
the value the table already carries is not a pending change at all — it is dropped
where it is chosen, so it cannot leave a review that looks unsaved (or count as work
in progress) for a choice the analyst took back. Leaving it unset means
the loader still tries a plain cast, so only wholly unparseable values stay text; the
published column then reports whatever actually loaded. A table whose temporal columns
are timestamps gets a timestamp-format control, because that is the field the loader
reads for them.

The review inbox also exposes semantic proposals, including their stored units,
inclusion/exclusion rule and optional time field. Pending counts and recent
imports refresh without replacing an active draft. Unsaved column-review edits
recover within the same session after reload with a clear unsaved indicator and
explicit discard. Recipe saves and approvals require the current revision; a
stale tab must discard/reload before continuing. Recovery drafts never authorize
ingestion; multi-tab recovery is covered by the integration suite.

**Refresh status** and **Refresh workspace** both re-fetch the review you have open,
not just the counters, because a proposal can be revised elsewhere — another tab, or
the agent re-previewing the source — and the analyst should not have to learn that
from a rejected approval. A refresh that finds a newer revision reloads the proposal
and says so ("Reloaded the latest proposal (revision N)"); a refresh that finds
nothing new says that too ("Proposal is current — revision N"). Neither ever
discards unsaved work: with edits pending, the newer revision is reported
("This proposal changed elsewhere — the grid now shows revision N. Save or discard
your column changes before approving.") and the editor stays stale and blocked until
the analyst saves or uses Discard draft and reload. A save the agent makes in chat
also reaches the open panel on its own — the review-status poll carries a digest of
saved revisions, so a new or deleted analysis refreshes the saved-view list with no
manual click, including a delete plus a create inside the same second.

Studio controls use the harness light/dark theme tokens. Native selects and their
options have explicit matching foreground/background colours; headers, borders
and changed rows use the same theme.

## Explore: fields, presentation and evidence

The saved view and population context appear first. Field definitions support
one table, aggregation, grouping, time grain and typed source predicates.
Field/population changes run the policy-gated query path on Apply. SQL views can
be styled without replacing their query; creating a field definition is explicit.

Presentation controls expose supported display choices, title, axis labels,
rounding, bar orientation, explicit integer/year ticks, legend and colours where
applicable. Suggest restrained blue for a single measure and a colourblind-friendly
categorical palette. Suggestions carry no inferred positive/negative meaning.
Native swatches and up to 20 typed series overrides are editable. Unsupported
controls are hidden; heatmaps and dual-measure displays keep template colours.

Categorical multi-series bars are grouped by default; additive stacking requires
explicit chart intent. Re-pinning preserves the existing card width and mappings.

Formatting reuses the authorised saved result and creates a new revision on
Apply. The preview remains the saved view while a draft is pending. Apply/Discard
and expected-revision guards prevent silent replacement. Recovered analysis drafts
remain attached to their original resource; navigation is guarded until resolved.
Restoring history creates a new revision and preserves previous revisions.

Paged exact values, deterministic result facts and Query and provenance remain
available. Full rows and SVG stay outside model context. Result facts describe
stored query rows, not an inferred source population. A truncated sample is not
sufficient evidence for a maximum, total or proportion.

## Dashboard: deliberate pins and filter scope

Add named saved views; reorder, remove or choose one-column/full-width slots.
Pins retain specific revisions. Review a newer revision explicitly before saving
the layout. Routine actions do not require internal IDs.

Shared filters restrict mapped saved-result fields; they do not recompute source
aggregations. Field mappings show which cards participate. Without a mapping,
controls are disabled with guidance rather than accepting guessed columns.
Use Explore population filters when the analytical population must change.
Layout drafts must be saved or discarded before filtering or exporting.
Active shared filters show the field/value, saved-result scope and affected-card
counts. Replacing a value uses the recorded base revision; Clear restores its
result while retaining current presentation and layout. Switching filter fields
requires Clear first. Legacy filtered views without trustworthy base metadata
show the limitation and use explicit history recovery.

## Report and chat cards

Choose Analytical brief, Comparison or Executive summary. Export the selected
saved revision; apply drafts first. Compact dashboard and report tool cards provide
one main opening action. Open report navigates directly to the authenticated web
preview, including in embedded browsers; Back returns to dsh. Offline downloads
are secondary. HTML snapshots include charts, values, query/provenance and caveats;
they do not promise live service-backed filtering when disconnected.
Studio Report keeps recent exports across restarts, independently of collapsed
chat tool groups or the selected analysis. Cards show the source revision, time,
Open report and secondary downloads; missing files are disclosed. History tracks
new successful exports, not inferred legacy files. Reports can include structured
findings/caveats/next steps. These narrative sections are distinct from verified
result facts; display rounding never changes the downloadable exact values.

Keep chat handoffs to outcome, material caveat and next action. Label filter scope
on its own line and suggested questions as separate bullets. IDs belong in
provenance. Model adherence is advisory; deterministic cards supply reliable
navigation even when the prose is verbose. Upstream tool groups may be collapsed.

## Layout and accessibility rules

Use harness theme tokens, readable text, aligned controls, visible keyboard focus
and non-colour status labels. Wrap toolbars and controls at narrow pane widths;
contain wide table scrolling. Use clear section spacing, short titles and optional
context/provenance drawers. Do not open another resource over an unsaved draft.
Verify normal and narrow panes, save/reopen, error recovery and actual output.
The GTD walkthrough tested approximately 710 px and 450 px sidebars; this is not a
universal accessibility or device certification.

## Deferred UI scope

Multi-table visual modelling, arbitrary field-role editing, multi-value/range
filter builders, direct chart brushing, editable narrative blocks, dedicated PDF
export require further work. Existing service
marks exceed the options that any one saved view can meaningfully expose.

## Interaction rationale

Column grids make type review scannable; persistent modes keep routine work out
of chat. Explicit draft states prevent accidental changes. Pinned revisions and
filter-scope labels make population changes visible. Report cards provide a stable
opening action even when chat tool groups collapse. These choices support a
bounded analyst workflow; they do not claim parity with enterprise BI platforms.
