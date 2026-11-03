# Viewport

Responsive viewport control is implemented as
`Emulation.setDeviceMetricsOverride` on the guest — the same mechanism a device
toolbar uses.

```js
await tab.setViewportSize({ width: 390, height: 844 });   // phone-ish
await tab.setViewportSize({ width: 1440, height: 900 });  // desktop-ish
tab.viewportSize();                                        // last value set in this kernel
```

## Bounds

`width` 320–3840, `height` 320–2160, integers. Out-of-range input is rejected, not
clamped, so a layout bug cannot be mistaken for a viewport bug.

## Reading the real size

`viewportSize()` reports what this tab object last set — it is not a live query.
For the actual painted size, ask the page:

```js
await tab.evaluate(() => ({ width: innerWidth, height: innerHeight }));
```

`tabs.list()` also reports `viewport: { width, height }` per tab, measured the same
way.

## Notes

- The override lives with the page, so it survives navigation and persists until you
  change it or reload with `tab.reload()`.
- Setting a viewport does **not** make an unpainted tab paintable; screenshots still
  require the tab to be the visible one.
