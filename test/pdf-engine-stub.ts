// Card integration tests do not open PDF documents or start workers.
export const pdfjsLib = {};
export const LOG_TAG = "test";
export const initPdfEngine = () => ({ ok: true });
export const getPdfEngineStatus = initPdfEngine;
export const createDedicatedWorker = () => null;
