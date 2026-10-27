import { createStore } from './store.js';

// Guests use the same cycle engine with memory-only persistence.
export function createDemoStore() { return createStore(); }
