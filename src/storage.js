import { DEFAULT_SETTINGS, SETTINGS_KEY } from "./constants.js";

/**
 * Loads persisted popup settings, falling back to production-safe defaults.
 * @returns {Promise<{ concurrency: number }>}
 */
export async function loadSettings() {
  try {
    const result = await chrome.storage.local.get(SETTINGS_KEY);
    return {
      ...DEFAULT_SETTINGS,
      ...(result[SETTINGS_KEY] || {})
    };
  } catch (error) {
    console.warn("Unable to load QA Toolkit settings; using defaults.", error);
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Persists popup settings in chrome.storage.
 * @param {{ concurrency?: number }} settings
 * @returns {Promise<void>}
 */
export async function saveSettings(settings) {
  try {
    await chrome.storage.local.set({
      [SETTINGS_KEY]: {
        ...DEFAULT_SETTINGS,
        ...settings
      }
    });
  } catch (error) {
    console.warn("Unable to save QA Toolkit settings.", error);
    throw error;
  }
}
