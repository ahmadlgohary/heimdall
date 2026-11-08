import { setupWorker } from 'msw/browser'
import { ensureSeeded, handlers } from './handlers'

ensureSeeded()
export const worker = setupWorker(...handlers)
