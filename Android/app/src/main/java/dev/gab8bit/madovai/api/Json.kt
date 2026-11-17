package dev.gab8bit.madovai.api

import dev.gab8bit.madovai.model.AstralDeparture
import dev.gab8bit.madovai.model.AstralLine
import dev.gab8bit.madovai.model.AstralScheduleDirection
import dev.gab8bit.madovai.model.AtacArrival
import dev.gab8bit.madovai.model.AtacStop
import dev.gab8bit.madovai.model.AtacTrip
import dev.gab8bit.madovai.model.CotralPoleInfo
import dev.gab8bit.madovai.model.CotralTransits
import dev.gab8bit.madovai.model.Health
import dev.gab8bit.madovai.model.LatLon
import dev.gab8bit.madovai.model.LineDetail
import dev.gab8bit.madovai.model.LineStop
import dev.gab8bit.madovai.model.LinesCatalog
import dev.gab8bit.madovai.model.MapShape
import dev.gab8bit.madovai.model.Pole
import dev.gab8bit.madovai.model.PoleInfo
import dev.gab8bit.madovai.model.Polyline
import dev.gab8bit.madovai.model.RailSchedule
import dev.gab8bit.madovai.model.RouteInfo
import dev.gab8bit.madovai.model.SearchResults
import dev.gab8bit.madovai.model.SearchStop
import dev.gab8bit.madovai.model.Transit
import dev.gab8bit.madovai.model.TransitOperator
import dev.gab8bit.madovai.model.TransitVehicle
import dev.gab8bit.madovai.model.TransitVehicleKind
import dev.gab8bit.madovai.model.ViewportStops
import org.json.JSONArray
import org.json.JSONObject

/**
 * Hand-written decoding of the backend's JSON (contract: Backend/docs/API.md +
 * Web/docs/API.md). org.json ships with Android, so there's no reflection and nothing for
 * R8 to keep. Deliberately tolerant like the iOS decoders: optional fields may be null or
 * missing, unknown fields are ignored, a malformed element is skipped rather than failing
 * the whole response.
 *
 * Careful with org.json on Android: `optString` returns the string "null" for a JSON null —
 * every string read goes through [str], which checks `isNull` first.
 */
object Json {
    // region primitives

    fun str(o: JSONObject, key: String): String? = if (o.isNull(key)) null else o.optString(key)
    fun strOr(o: JSONObject, key: String, fallback: String = ""): String = str(o, key) ?: fallback
    fun nonEmpty(o: JSONObject, key: String): String? = str(o, key)?.trim()?.takeIf { it.isNotEmpty() }
    fun dbl(o: JSONObject, key: String): Double? = if (o.isNull(key)) null else o.optDouble(key).takeIf { !it.isNaN() }
    fun int(o: JSONObject, key: String): Int? = if (o.isNull(key)) null else when (val v = o.opt(key)) {
        is Number -> v.toInt()
        is String -> v.trim().toDoubleOrNull()?.toInt()
        else -> null
    }
    fun long(o: JSONObject, key: String): Long? = if (o.isNull(key)) null else when (val v = o.opt(key)) {
        is Number -> v.toLong()
        is String -> v.trim().toDoubleOrNull()?.toLong()
        else -> null
    }
    fun bool(o: JSONObject, key: String): Boolean? = if (o.isNull(key)) null else when (val v = o.opt(key)) {
        is Boolean -> v
        is Number -> v.toInt() != 0
        is String -> v.trim().let { it == "true" || it == "1" }
        else -> null
    }

    inline fun <T> JSONArray?.objects(transform: (JSONObject) -> T?): List<T> {
        if (this == null) return emptyList()
        val out = ArrayList<T>(length())
        for (i in 0 until length()) {
            val o = optJSONObject(i) ?: continue
            runCatching { transform(o) }.getOrNull()?.let(out::add)
        }
        return out
    }

    fun strings(a: JSONArray?): List<String> {
        if (a == null) return emptyList()
        return (0 until a.length()).mapNotNull { i -> if (a.isNull(i)) null else a.optString(i).trim().takeIf { it.isNotEmpty() } }
    }

    // endregion

    // region shared objects

    fun route(o: JSONObject): RouteInfo? {
        val id = nonEmpty(o, "id") ?: return null
        val source = nonEmpty(o, "source") ?: "atac"
        val shortName = str(o, "shortName") ?: id
        val rail = bool(o, "rail") ?: false
        return RouteInfo(
            source = source,
            routeId = id,
            shortName = shortName,
            longName = strOr(o, "longName"),
            displayName = nonEmpty(o, "displayName") ?: shortName,
            kind = TransitVehicleKind.fromApi(str(o, "kind")) ?: if (rail) TransitVehicleKind.TRENO else TransitVehicleKind.BUS,
            transitOperator = TransitOperator.fromApi(str(o, "operator")) ?: if (source == "cotral") TransitOperator.COTRAL else TransitOperator.ATAC,
            colorHex = nonEmpty(o, "color"),
            rail = rail,
        )
    }

    fun searchStop(o: JSONObject): SearchStop? {
        val id = nonEmpty(o, "id") ?: return null
        val lat = dbl(o, "lat") ?: return null
        val lon = dbl(o, "lon") ?: return null
        return SearchStop(
            source = nonEmpty(o, "source") ?: "atac",
            stopId = id,
            name = str(o, "name") ?: id,
            lat = lat,
            lon = lon,
            rail = bool(o, "rail") ?: false,
            metro = bool(o, "metro") ?: false,
        )
    }

    fun lineStop(o: JSONObject): LineStop? {
        val id = nonEmpty(o, "id") ?: return null
        return LineStop(id, str(o, "name") ?: id, dbl(o, "lat") ?: return null, dbl(o, "lon") ?: return null, nonEmpty(o, "headsign"))
    }

    fun departure(o: JSONObject): AstralDeparture? {
        val time = nonEmpty(o, "time") ?: return null
        return AstralDeparture(
            id = str(o, "id") ?: time,
            time = time,
            sortSeconds = int(o, "sortSeconds") ?: return null,
            delayMinutes = int(o, "delayMinutes"),
            isCancelled = bool(o, "isCancelled") ?: false,
            isReplacementBus = bool(o, "isReplacementBus") ?: false,
        )
    }

    fun arrival(o: JSONObject): AtacArrival? {
        val ts = long(o, "ts") ?: return null
        val routeId = strOr(o, "routeId")
        return AtacArrival(
            tripId = nonEmpty(o, "tripId") ?: ts.toString(),
            routeId = routeId,
            routeLabel = nonEmpty(o, "routeLabel") ?: routeId,
            kind = TransitVehicleKind.fromApi(str(o, "kind")) ?: TransitVehicleKind.BUS,
            ts = ts,
            delaySeconds = int(o, "delaySeconds"),
            headsign = nonEmpty(o, "headsign"),
            cancelled = bool(o, "cancelled") ?: false,
        )
    }

    fun transit(o: JSONObject): Transit = Transit(
        idCorsa = strOr(o, "idCorsa"),
        percorso = strOr(o, "percorso").trim(),
        partenzaCorsa = strOr(o, "partenzaCorsa"),
        orarioPartenzaCorsa = strOr(o, "orarioPartenzaCorsa").trim(),
        arrivoCorsa = strOr(o, "arrivoCorsa"),
        orarioArrivoCorsa = strOr(o, "orarioArrivoCorsa").trim(),
        soppressa = strOr(o, "soppressa"),
        tempoTransito = strOr(o, "tempoTransito").trim(),
        ritardoSeconds = int(o, "ritardoSeconds") ?: 0,
        vehicleCode = nonEmpty(o, "vehicleCode"),
        vehicleAlive = bool(o, "vehicleAlive") ?: false,
        instradamento = strOr(o, "instradamento").trim(),
        banchina = strOr(o, "banchina").trim(),
        monitorata = strOr(o, "monitorata").trim(),
    )

    private fun shape(o: JSONObject, routeId: String, kind: TransitVehicleKind, color: String?, forceRoute: Boolean): MapShape? {
        val coords = str(o, "coords") ?: return null
        val points = Polyline.decode(coords)
        if (points.size < 2) return null
        return MapShape(
            id = nonEmpty(o, "id") ?: coords.hashCode().toString(),
            routeId = if (forceRoute) routeId else nonEmpty(o, "routeId") ?: routeId,
            kind = if (forceRoute) kind else TransitVehicleKind.fromApi(str(o, "kind")) ?: kind,
            colorHex = if (forceRoute) color else nonEmpty(o, "color") ?: color,
            points = points,
        )
    }

    // endregion

    // region endpoints

    fun health(text: String): Health = JSONObject(text).let { Health(bool(it, "ok") ?: false, nonEmpty(it, "version"), bool(it, "gtfsReady") ?: false) }

    fun search(text: String): SearchResults = JSONObject(text).let {
        SearchResults(it.optJSONArray("stops").objects(::searchStop), it.optJSONArray("routes").objects(::route))
    }

    fun stops(text: String): ViewportStops {
        val o = JSONObject(text)
        val poles = o.optJSONArray("cotral").objects { s ->
            val id = nonEmpty(s, "id") ?: return@objects null
            val name = str(s, "name") ?: id
            Pole.fromStop(id, name, nonEmpty(s, "locality"), dbl(s, "lat"), dbl(s, "lon"), bool(s, "rail") ?: false)
        }
        val atac = o.optJSONArray("atac").objects { s ->
            val id = nonEmpty(s, "id") ?: return@objects null
            AtacStop(id, str(s, "name") ?: id, dbl(s, "lat") ?: return@objects null, dbl(s, "lon") ?: return@objects null)
        }
        return ViewportStops(poles, atac)
    }

    fun shapes(text: String): List<MapShape> =
        JSONObject(text).optJSONArray("shapes").objects { shape(it, "", TransitVehicleKind.BUS, null, forceRoute = false) }

    fun lines(text: String): LinesCatalog = JSONObject(text).let {
        LinesCatalog(it.optJSONArray("atac").objects(::route), it.optJSONArray("cotralRail").objects(::route))
    }

    fun line(text: String): LineDetail {
        val o = JSONObject(text)
        val route = o.optJSONObject("route")?.let(::route) ?: throw ApiException.decoding()
        // A Cotral line can only draw shapes for rail; Atac shapes take the route's own kind/colour.
        val kind = if (route.isCotral) TransitVehicleKind.TRENO else route.kind
        return LineDetail(
            route = route,
            // Backend order is route order (directions + branches): keep it, never re-sort.
            stops = o.optJSONArray("stops").objects(::lineStop),
            shapes = o.optJSONArray("shapes").objects { shape(it, route.routeId, kind, route.colorHex, forceRoute = true) },
        )
    }

    fun atacStop(text: String): List<AtacStop> =
        JSONObject(text).optJSONArray("stops").objects { lineStop(it)?.asAtacStop() }

    fun atacSchedule(text: String): List<AtacArrival> = JSONArray(text).objects(::arrival).sortedBy { it.ts }

    fun pole(text: String): PoleInfo = JSONObject(text).let {
        PoleInfo(
            id = nonEmpty(it, "id") ?: throw ApiException.decoding(),
            name = nonEmpty(it, "name"),
            locality = nonEmpty(it, "locality"),
            lat = dbl(it, "lat"),
            lon = dbl(it, "lon"),
            rail = bool(it, "rail") ?: false,
            trainRoutes = strings(it.optJSONArray("trainRoutes")),
        )
    }

    fun rail(text: String): RailSchedule {
        val o = JSONObject(text)
        val directions = o.optJSONArray("directions").objects { d ->
            AstralScheduleDirection(
                destination = nonEmpty(d, "destination") ?: return@objects null,
                route = nonEmpty(d, "route"),
                entries = d.optJSONArray("entries").objects(::departure).sortedBy { it.sortSeconds },
            )
        }
        return RailSchedule(nonEmpty(o, "source") ?: "none", directions)
    }

    fun cotralTransits(text: String): CotralTransits {
        val o = JSONObject(text)
        val pole = o.optJSONObject("pole")?.let {
            CotralPoleInfo(nonEmpty(it, "code"), nonEmpty(it, "name"), nonEmpty(it, "stopName"), nonEmpty(it, "locality"), nonEmpty(it, "comune"), dbl(it, "lat"), dbl(it, "lon"))
        }
        return CotralTransits(pole, o.optJSONArray("transits").objects(::transit))
    }

    /** `cotral-vehicle`: `{"lat":null,"lon":null}` (or a (0,0) fix) means "no position right now". */
    fun cotralVehicle(text: String): LatLon? = JSONObject(text).let { o ->
        val lat = dbl(o, "lat") ?: return@let null
        val lon = dbl(o, "lon") ?: return@let null
        LatLon(lat, lon).takeIf { it.isValidForMap }
    }

    fun cotralVehicles(text: String): List<TransitVehicle> =
        JSONObject(text).optJSONArray("vehicles").objects { v ->
            val coordinate = LatLon(dbl(v, "lat") ?: return@objects null, dbl(v, "lon") ?: return@objects null)
            if (!coordinate.isValidForMap) return@objects null
            val code = nonEmpty(v, "code")
            TransitVehicle(
                id = nonEmpty(v, "id") ?: "cotral-${code ?: return@objects null}",
                coordinate = coordinate,
                bearing = null,
                routeId = nonEmpty(v, "routeId"),
                routeLabel = nonEmpty(v, "routeLabel"),
                kind = TransitVehicleKind.fromApi(str(v, "kind")) ?: TransitVehicleKind.BUS,
                transitOperator = TransitOperator.COTRAL,
                delaySeconds = int(v, "delaySeconds"),
                tripId = nonEmpty(v, "tripId"),
                headsign = null,
                vehicleCode = code,
            )
        }

    fun astralLine(text: String): AstralLine {
        val o = JSONObject(text)
        return AstralLine(
            route = strOr(o, "route"),
            directionLabel = nonEmpty(o, "directionLabel"),
            lineName = nonEmpty(o, "lineName"),
            stations = o.optJSONArray("stations").objects { s ->
                AstralLine.Station(nonEmpty(s, "name") ?: return@objects null, nonEmpty(s, "code"), int(s, "order"), s.optJSONObject("next")?.let(::departure))
            },
        )
    }

    data class AtacFleet(val updatedUnix: Long?, val vehicles: List<TransitVehicle>)

    fun atacVehicles(text: String): AtacFleet {
        val o = JSONObject(text)
        val vehicles = o.optJSONArray("vehicles").objects { v ->
            val coordinate = LatLon(dbl(v, "lat") ?: return@objects null, dbl(v, "lon") ?: return@objects null)
            if (!coordinate.isValidForMap) return@objects null
            TransitVehicle(
                id = nonEmpty(v, "id") ?: return@objects null,
                coordinate = coordinate,
                bearing = dbl(v, "bearing"),
                routeId = nonEmpty(v, "routeId"),
                routeLabel = nonEmpty(v, "routeLabel"),
                kind = TransitVehicleKind.fromApi(str(v, "kind")) ?: TransitVehicleKind.BUS,
                transitOperator = TransitOperator.fromApi(str(v, "operator")) ?: TransitOperator.ATAC,
                delaySeconds = null,
                tripId = nonEmpty(v, "tripId"),
                headsign = nonEmpty(v, "headsign"),
                vehicleCode = null,
            )
        }
        return AtacFleet(long(o, "updated"), vehicles)
    }

    /** `atac-live`: stop id → arrivals, each list soonest first. */
    fun atacLive(text: String): Map<String, List<AtacArrival>> {
        val stops = JSONObject(text).optJSONObject("stops") ?: return emptyMap()
        val out = HashMap<String, List<AtacArrival>>()
        for (key in stops.keys()) out[key] = stops.optJSONArray(key).objects(::arrival).sortedBy { it.ts }
        return out
    }

    fun atacTrip(text: String): AtacTrip {
        val o = JSONObject(text)
        return AtacTrip(
            tripId = nonEmpty(o, "tripId"),
            routeId = nonEmpty(o, "routeId"),
            routeLabel = nonEmpty(o, "routeLabel"),
            headsign = nonEmpty(o, "headsign"),
            stops = o.optJSONArray("stops").objects { s ->
                AtacTrip.Stop(
                    stopId = nonEmpty(s, "stopId") ?: return@objects null,
                    stopName = str(s, "stopName") ?: "",
                    sequence = int(s, "sequence") ?: 0,
                    ts = long(s, "ts") ?: return@objects null,
                    delaySeconds = int(s, "delaySeconds"),
                )
            }.sortedBy { it.sequence },
        )
    }

    // endregion
}
