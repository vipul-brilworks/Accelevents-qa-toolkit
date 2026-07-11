const SESSION_KEY = "acceleventsQaToolkitSession";
const MAX_AGE_MS = 4 * 60 * 60 * 1000; // 4 hours

/**
 * Persists the current popup UI state to chrome.storage.session.
 * State is keyed by event slug so it is automatically invalidated when the
 * user navigates to a different event without clearing anything manually.
 * @param {object} data
 * @returns {Promise<void>}
 */
export async function saveUIState(data) {
  try {
    await chrome.storage.session.set({
      [SESSION_KEY]: { ...data, savedAt: Date.now() }
    });
  } catch (error) {
    console.warn("QA Toolkit: unable to save session state.", error);
  }
}

/**
 * Reads the persisted UI state from chrome.storage.session.
 * Returns null when nothing is saved, state is stale, or the API is unavailable.
 * @returns {Promise<object|null>}
 */
export async function restoreUIState() {
  try {
    const result = await chrome.storage.session.get(SESSION_KEY);
    const saved = result[SESSION_KEY];
    if (!saved) return null;
    if (Date.now() - (saved.savedAt || 0) > MAX_AGE_MS) return null;
    return saved;
  } catch (error) {
    console.warn("QA Toolkit: unable to restore session state.", error);
    return null;
  }
}

/**
 * Removes all persisted UI state.
 * @returns {Promise<void>}
 */
export async function clearUIState() {
  try {
    await chrome.storage.session.remove(SESSION_KEY);
  } catch (error) {
    console.warn("QA Toolkit: unable to clear session state.", error);
  }
}
