# SWEGEO UI Refine (Non-Breaking) Design

Date: 2026-03-30
Project: SWEGEO GNSS App (`src/renderer`)
Scope: Visual/UI refinement only

## 1. Goal

Refine the renderer UI to look cleaner and more consistent with SWEGEO brand language while preserving all existing behavior.

Success means:
- All current flows continue to work exactly as before.
- SWEGEO color language is enforced consistently.
- Typography/spacing/focus/motion quality is improved.
- CSS architecture is simplified to reduce style conflicts.

## 2. Hard Constraints (Non-Negotiable)

- No functional change in connection, dashboard telemetry, terminal, settings, NTRIP, update panel, or dialogs.
- No backend/main/preload changes.
- No IPC channel, event name, id, data attribute, or JS behavior changes.
- Existing component contracts remain intact.

## 3. In-Scope Changes

- `src/renderer/styles.css`
- `src/renderer/index.html` (only non-functional markup cleanup)

### Allowed in HTML
- Remove invalid/missing script include (`VelocityCard.js`) if unused.
- Replace inline styles with semantic classes (same visual outcome).
- Keep all ids used by JS untouched.

## 4. Design Approach

Selected approach: Balanced Refine

1. Brand token consolidation
2. CSS conflict cleanup (duplicate global definitions removed)
3. Visual consistency pass (cards, nav, modal, controls)
4. Accessibility pass (`:focus-visible`, readable minimum sizes)
5. Motion restraint + reduced-motion support
6. HTML inline-style cleanup + dead script cleanup

## 5. Visual System Specification

### 5.1 Brand Color Policy

Base palette:
- Blue: `#114D88`
- Yellow: `#FFBE00`
- Gray: `#9099A9`

Usage rule:
- Solid colors must be one of the three base colors or `#FFFFFF` where needed.
- State emphasis should come from alpha variants of base colors.
- Existing non-brand green/red/purple/cyan accents are replaced with brand-consistent state treatments.

State model (brand-safe):
- Active/connected: blue emphasis + yellow accent indicators
- Warning/attention: yellow emphasis
- Error/critical: high-contrast blue/yellow treatment with stronger typography/iconography (no off-brand red dependency)
- Neutral/inactive: gray variants

### 5.2 Typography

- Keep existing bundled families.
- Raise critical micro-text to minimum 11px where readability suffers.
- Keep numeric/telemetry fields in mono where scanning benefits.
- Enforce consistent title/label/value hierarchy.

### 5.3 Spacing and Surfaces

- Normalize card paddings, radii, and shadow intensity across pages.
- Reduce unnecessary visual noise (overly glossy effects, stacked ornamental shadows).
- Keep high information density but improve scannability.

## 6. CSS Architecture Changes

### 6.1 Remove Duplicated Global Blocks

Unify duplicate rules into single source definitions:
- `.btn-primary`, `.btn-secondary`, `.btn-sm`, related hover/active
- `.messages-search` and focus states
- overlapping utility blocks that currently depend on later-file override order

Outcome:
- deterministic style behavior
- easier maintenance
- less accidental regressions

### 6.2 Introduce Clear Section Boundaries

- Group style blocks by page/component zone.
- Keep shared tokens and global primitives near top.
- Keep component/page-specific overrides scoped and explicit.

## 7. Accessibility and Interaction

- Add consistent `:focus-visible` rings for keyboard navigation.
- Remove blanket `outline: none` patterns where no replacement exists.
- Ensure contrast for labels and status text is acceptable for operational UI.
- Add `@media (prefers-reduced-motion: reduce)` to disable non-essential animations.

## 8. Functional Safety Strategy

No JS behavior changes by design. Safety is ensured by:

- preserving DOM ids referenced by components
- preserving button/input structure expected by event listeners
- preserving class hooks that are used as JS selectors/state toggles
- limiting HTML edits to non-behavioral cleanup

## 9. Verification Plan

### 9.1 Static checks

- No renderer JS files modified (except optional import cleanup confirmation).
- No preload/main/backend file changes.
- No id removals from `index.html`.

### 9.2 Manual runtime checks

Must pass end-to-end:
- Connection dialog: Serial/TCP/UDP open/close
- Sidebar navigation between all pages
- Dashboard cards update with live data and toggles
- Terminal line streaming + command send
- Settings panels actions and previews
- NTRIP connect/disconnect + status updates
- Updater panel interaction states

### 9.3 Regression indicators

- No console errors related to missing DOM nodes/scripts
- No broken click handlers
- No hidden/overlapping critical controls at standard window sizes

## 10. Rollout Order

1. Token + color normalization
2. Duplicate class consolidation
3. Focus/motion accessibility pass
4. HTML inline-style class extraction
5. Dead script reference removal (if confirmed unused)
6. Runtime verification sweep

## 11. Risks and Mitigations

Risk: style consolidation changes visual intent unexpectedly.
- Mitigation: apply in small chunks and validate each page after chunk.

Risk: class cleanup accidentally removes a selector used by JS.
- Mitigation: preserve JS-referenced classes/ids; do not rename selector contracts.

Risk: removing missing script include reveals hidden dependency.
- Mitigation: verify no runtime reference exists before finalizing.

## 12. Out of Scope

- New UI features
- New interaction patterns requiring JS logic changes
- Backend protocol/message or IPC modifications
- Data model/schema changes
