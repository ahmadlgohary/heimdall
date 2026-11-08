import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest'
import { tokenStore } from '@/lib/auth'
import { handlers, mockConfig, resetMockDb } from '@/mocks/handlers'

export const server = setupServer(...handlers)

// jsdom gaps used by Radix, Recharts and CodeMirror
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia
Element.prototype.scrollIntoView ??= () => {}
Element.prototype.hasPointerCapture ??= () => false
Element.prototype.releasePointerCapture ??= () => {}
const rect = () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}) })
Range.prototype.getBoundingClientRect ??= rect as () => DOMRect
Range.prototype.getClientRects ??= (() => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] })) as unknown as () => DOMRectList

beforeAll(() => {
  mockConfig.latency = false
  server.listen({ onUnhandledFrame: 'error' })
})
beforeEach(() => {
  localStorage.clear()
  tokenStore.set(null)
  resetMockDb()
})
afterEach(() => {
  cleanup()
  server.resetHandlers()
})
afterAll(() => server.close())
