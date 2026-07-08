# Accelevents QA Toolkit

Manifest V3 Chrome extension for QA utilities on Accelevents Dev Admin pages.

## Load Unpacked

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Select **Load unpacked**.
4. Choose this folder: `accelevents-qa-toolkit`.

## Current Scope

- Runs only on `https://www.devaccel.com/*`.
- Calls `https://api.devaccel.com/*` with the logged-in browser session.
- Does not store or hardcode authentication tokens.
- Detects the event slug from the active tab URL.
- Loads all orders with pagination, previews them, filters them, supports selection, deletes with confirmation, retries retryable API failures, supports cancellation, writes a CSV report, and refreshes the page when done.

## Notes

The order normalizer is intentionally defensive because API field names can vary across admin views. If Accelevents returns a new order payload shape, update `src/orders.js`.
