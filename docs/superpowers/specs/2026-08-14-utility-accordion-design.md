# Utility accordion design

## Scope

Add a separate `Utility` navigation accordion. It contains only the existing Lookup route. The current `Utilities` group retains Tuition, Documents, and Training Points. Lookup is removed from that static group.

## Interaction

- `Utility` is a full-width sidebar button with an icon, label, and chevron.
- Clicking it toggles the Lookup child link.
- Its expanded state persists in `localStorage` and is shared by the desktop sidebar and mobile navigation drawer.
- When `/lookup` is active, Utility is open even if its stored state was collapsed.
- In collapsed desktop-sidebar mode, Utility remains icon-only and does not expose a submenu. The usual expanded sidebar exposes the control and child.

## Accessibility

- Utility is a semantic button.
- `aria-expanded` reflects the visible child region.
- The control uses `aria-controls` for the Lookup region.
- The child remains a normal routed link with active `aria-current="page"` behavior.

## Localization

Add English and Vietnamese strings for the singular Utility section and collapse/expand labels as needed. No JSX-authored copy.

## Tests

Extend shell Playwright coverage:

1. Utility toggles Lookup visibility and updates `aria-expanded`.
2. Lookup navigation marks the child current and opens Utility.
3. The drawer has matching accordion behavior.
4. Stored state survives reload.

## Exclusions

No new route, server API, preference framework, animation package, or changes to existing Utilities membership beyond removing Lookup.
