package dev.gab8bit.madovai

/**
 * App-wide configuration.
 *
 * Since 2.0 every piece of data comes from the Madovai backend
 * (`https://madovai.gab8bit.net/api/v1`, contract in the monorepo's Backend/docs/API.md and
 * Web/docs/API.md): the app no longer downloads GTFS archives, decodes GTFS-Realtime
 * protobuf, parses Cotral's XML or talks to ASTRAL itself. Intervals and thresholds mirror
 * the iOS app's `Config.swift` (2.0), which mirrors the web app's `services.js`.
 */
object Config {
    /** Base URL of the backend's versioned API — the only host the app talks to besides OSM tiles. */
    const val API_BASE_URL = "https://madovai.gab8bit.net/api/v1"

    /** `GET /health` lives at the server root, not under `/api/v1`. */
    const val HEALTH_URL = "https://madovai.gab8bit.net/health"

    /** Timeout for a single API request. */
    const val REQUEST_TIMEOUT_SECONDS = 15L

    /** How often an open stop/station sheet refreshes its departures. */
    const val TRANSITS_POLL_INTERVAL_MS = 15_000L

    /** How often a followed Cotral vehicle's position is refreshed. */
    const val VEHICLE_POSITION_POLL_INTERVAL_MS = 12_000L

    /** Consecutive failed/empty position polls before live tracking is reported lost. */
    const val VEHICLE_TRACKING_LOSS_THRESHOLD = 2

    /** The whole Atac/Roma TPL fleet (one call, cached a few seconds server-side). */
    const val ATAC_FLEET_POLL_INTERVAL_MS = 15_000L

    /** Cotral vehicles near the visible poles (server-side fan-out). */
    const val COTRAL_VIEWPORT_VEHICLE_POLL_INTERVAL_MS = 18_000L

    /** An open Atac vehicle's trip schedule / a line's arrivals. */
    const val ATAC_TRIP_POLL_INTERVAL_MS = 18_000L

    /** ASTRAL's line-wide "next train at every station" (Cotral train sheet). */
    const val ASTRAL_LINE_POLL_INTERVAL_MS = 30_000L

    /** The backend accepts at most 15 poles per `cotral-vehicles` call. */
    const val COTRAL_VIEWPORT_POLE_QUERY_LIMIT = 15

    /** The backend accepts at most 150 stops per `atac-live` call. */
    const val ATAC_LIVE_STOP_LIMIT = 150

    /** Debounce after the map stops moving before stops/lines are reloaded. */
    const val VIEWPORT_SETTLE_DELAY_MS = 450L

    /** Only show "Caricamento dati…" when a request is actually slow — no flicker on fast connections. */
    const val SLOW_REQUEST_HINT_DELAY_MS = 400L

    /** Debounce of the search fields. */
    const val SEARCH_DEBOUNCE_MS = 220L

    /** Below this zoom no stops/lines are loaded (a regional view would drown in markers). */
    const val MIN_DATA_ZOOM = 13.0

    /** Below this zoom ambient vehicles aren't drawn; a focused line still shows its own at any zoom. */
    const val MIN_VEHICLE_ZOOM = 11.0

    /** From this zoom vehicles are labelled badges; below it small dots. */
    const val VEHICLE_BADGE_ZOOM = 14.0

    /** Reminders: a failed check (network, nothing upcoming) is retried after this long… */
    const val REMINDER_RETRY_INTERVAL_MS = 120_000L

    /** …at most this many times, then the reminder waits for its next occurrence (same as the backend). */
    const val REMINDER_MAX_RETRIES = 15

    /** A retry chain older than this is abandoned (same as the backend's scheduler). */
    const val REMINDER_CHAIN_MAX_AGE_MS = 60 * 60_000L

    /** The reminder check runs inside a BroadcastReceiver (≈10 s budget): requests must be quicker than that. */
    const val REMINDER_REQUEST_TIMEOUT_SECONDS = 8L

    /** Identifies this app to the OSM tile servers, per the OSM tile usage policy. */
    val OSM_USER_AGENT = "Madovai-Android/${BuildConfig.VERSION_NAME} (${BuildConfig.APPLICATION_ID}; personal transit tracker)"

    /** Sent to the backend so its logs can tell clients apart. */
    val API_USER_AGENT = "Madovai-Android/${BuildConfig.VERSION_NAME}"
}
