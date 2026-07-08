/** @const {number} */
export const PAGE_SIZE = 100;
/** @const {Set<number>} */
export const RETRYABLE_STATUS_CODES = new Set([429, 500, 503]);
/** @const {string} */
export const SETTINGS_KEY = "acceleventsQaToolkitSettings";

/** @type {{ concurrency: number }} */
export const DEFAULT_SETTINGS = Object.freeze({
  concurrency: 3
});

/** @type {Record<string, { environment: string, webOrigin: string, apiOrigin: string }>} */
export const ENVIRONMENT_BY_HOST = Object.freeze({
  "www.devaccel.com": Object.freeze({
    environment: "DEV",
    webOrigin: "https://www.devaccel.com",
    apiOrigin: "https://api.devaccel.com"
  }),
  "www.stagingaccel.com": Object.freeze({
    environment: "STAGE",
    webOrigin: "https://www.stagingaccel.com",
    apiOrigin: "https://api.stagingaccel.com"
  }),
  "www.accelevents.com": Object.freeze({
    environment: "PROD",
    webOrigin: "https://www.accelevents.com",
    apiOrigin: "https://api.accelevents.com"
  })
});
