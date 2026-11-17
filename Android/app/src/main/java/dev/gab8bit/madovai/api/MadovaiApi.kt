package dev.gab8bit.madovai.api

import dev.gab8bit.madovai.Config
import dev.gab8bit.madovai.model.AstralLine
import dev.gab8bit.madovai.model.AtacArrival
import dev.gab8bit.madovai.model.AtacStop
import dev.gab8bit.madovai.model.AtacTrip
import dev.gab8bit.madovai.model.CotralTransits
import dev.gab8bit.madovai.model.Health
import dev.gab8bit.madovai.model.LatLon
import dev.gab8bit.madovai.model.LineDetail
import dev.gab8bit.madovai.model.LinesCatalog
import dev.gab8bit.madovai.model.MapShape
import dev.gab8bit.madovai.model.PoleInfo
import dev.gab8bit.madovai.model.RailSchedule
import dev.gab8bit.madovai.model.SearchResults
import dev.gab8bit.madovai.model.TransitVehicle
import dev.gab8bit.madovai.model.ViewportBounds
import dev.gab8bit.madovai.model.ViewportStops
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import okhttp3.OkHttpClient
import java.util.Locale
import java.util.concurrent.TimeUnit

/**
 * One method per backend endpoint the app uses (the same set as the web app, minus the
 * Web Push ones: reminders are local on Android). All calls are main-safe suspend
 * functions and return values ready for the UI (polylines decoded, DTOs mapped to models).
 */
class MadovaiApi(private val client: ApiClient) {

    // region server

    suspend fun health(): Health = client.getHealth(Json::health)

    // endregion

    // region static data

    suspend fun search(query: String): SearchResults =
        if (query.isBlank()) SearchResults.EMPTY else client.get("search", mapOf("q" to query.trim()), Json::search)

    /** Cotral poles + Atac stops inside a box, nearest to its centre first. */
    suspend fun stops(bounds: ViewportBounds, cotralLimit: Int = 120, atacLimit: Int = 400): ViewportStops =
        client.get("stops", bboxQuery(bounds) + mapOf("cotralLimit" to cotralLimit.toString(), "atacLimit" to atacLimit.toString()), Json::stops)

    /** Atac line shapes crossing a box. */
    suspend fun shapes(bounds: ViewportBounds, limit: Int = 150): List<MapShape> =
        client.get("shapes", bboxQuery(bounds) + mapOf("limit" to limit.toString()), Json::shapes)

    suspend fun lines(): LinesCatalog = client.get("lines", emptyMap(), Json::lines)

    /** `source` is "atac" or "cotral". */
    suspend fun line(source: String, id: String): LineDetail = client.get("line", mapOf("source" to source, "id" to id), Json::line)

    /** Every platform sharing the name of `id` (a station's directions), labelled for `route` when given. */
    suspend fun atacStop(id: String, route: String? = null): List<AtacStop> =
        client.get("atac-stop", mapOf("id" to id, "route" to route), Json::atacStop)

    /** Up to 6 *scheduled* (not real-time) departures from now. */
    suspend fun atacSchedule(stopId: String): List<AtacArrival> = client.get("atac-schedule", mapOf("stop" to stopId), Json::atacSchedule)

    suspend fun pole(id: String): PoleInfo = client.get("pole", mapOf("id" to id), Json::pole)

    suspend fun rail(stopId: String): RailSchedule = client.get("rail", mapOf("stop" to stopId), Json::rail)

    // endregion

    // region live data

    suspend fun cotralTransits(pole: String): CotralTransits = client.get("cotral-transits", mapOf("pole" to pole), Json::cotralTransits)

    /** null = the vehicle has no position right now. */
    suspend fun cotralVehicle(code: String): LatLon? = client.get("cotral-vehicle", mapOf("code" to code), Json::cotralVehicle)

    /** Trackable Cotral vehicles passing through the given poles (the backend takes at most 15). */
    suspend fun cotralVehicles(poles: List<String>): List<TransitVehicle> {
        val codes = poles.filter { it.isNotBlank() }.distinct().take(Config.COTRAL_VIEWPORT_POLE_QUERY_LIMIT)
        if (codes.isEmpty()) return emptyList()
        return client.get("cotral-vehicles", mapOf("poles" to codes.joinToString(",")), Json::cotralVehicles)
    }

    suspend fun astralLine(route: String): AstralLine = client.get("astral-line", mapOf("route" to route), Json::astralLine)

    suspend fun atacVehicles(): Json.AtacFleet = client.get("atac-vehicles", emptyMap(), Json::atacVehicles)

    /** Real-time arrivals for any number of stops (chunked to the backend's 150-stop limit), soonest first. */
    suspend fun atacLive(stopIds: List<String>): Map<String, List<AtacArrival>> {
        val unique = stopIds.filter { it.isNotBlank() }.distinct()
        if (unique.isEmpty()) return emptyMap()
        val parts = coroutineScope {
            unique.chunked(Config.ATAC_LIVE_STOP_LIMIT).map { chunk ->
                async { client.get("atac-live", mapOf("stops" to chunk.joinToString(",")), Json::atacLive) }
            }.awaitAll()
        }
        return parts.fold(HashMap()) { acc, part -> acc.apply { putAll(part) } }
    }

    suspend fun atacTrip(tripId: String): AtacTrip = client.get("atac-trip", mapOf("trip" to tripId), Json::atacTrip)

    // endregion

    companion object {
        fun bboxQuery(b: ViewportBounds): Map<String, String?> = mapOf(
            "minLat" to "%.5f".format(Locale.ROOT, b.minLat),
            "minLon" to "%.5f".format(Locale.ROOT, b.minLon),
            "maxLat" to "%.5f".format(Locale.ROOT, b.maxLat),
            "maxLon" to "%.5f".format(Locale.ROOT, b.maxLon),
        )

        fun httpClient(timeoutSeconds: Long = Config.REQUEST_TIMEOUT_SECONDS): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(timeoutSeconds, TimeUnit.SECONDS)
            .readTimeout(timeoutSeconds, TimeUnit.SECONDS)
            .callTimeout(timeoutSeconds * 2, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build()

        fun create(http: OkHttpClient = httpClient()): MadovaiApi =
            MadovaiApi(ApiClient(Config.API_BASE_URL, Config.HEALTH_URL, http, Config.API_USER_AGENT))
    }
}
