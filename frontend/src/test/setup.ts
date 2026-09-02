import '@testing-library/jest-dom'

// jsdom does not implement matchMedia at all — any component that reads a
// media query (e.g. threads-shell.tsx's desktop/audience-panel breakpoint)
// throws `window.matchMedia is not a function` in every test that mounts
// it, not just one. A minimal polyfill here (never matches, no-op
// listeners) fixes the shared chokepoint once instead of stubbing it
// per-test-file.
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })
}
