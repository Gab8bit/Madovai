package dev.gab8bit.madovai.model

/** A line as the backend describes it (`search`, `lines`, `line`). */
data class RouteInfo(
    /** "atac" or "cotral". */
    val source: String,
    /** Atac route id ("211", "MEA") or Cotral GTFS route id ("F:ROMALIDO" for rail). */
    val routeId: String,
    val shortName: String,
    val longName: String,
    /** The backend's display name: "Metro A" for metro lines, otherwise often the long description. */
    val displayName: String,
    val kind: TransitVehicleKind,
    val transitOperator: TransitOperator,
    /** "E27439" (no "#"), when the feed sets one. */
    val colorHex: String?,
    val rail: Boolean,
) {
    val id: String get() = "$source:$routeId"
    val isAtac: Boolean get() = source == "atac"
    val isCotral: Boolean get() = source == "cotral"
    val isMetro: Boolean get() = kind == TransitVehicleKind.METRO || AtacMetroLine.fromShortName(shortName) != null

    /** Icon kind: Cotral rail lines are trains, Cotral buses buses, Atac per its own kind. */
    val iconKind: TransitVehicleKind
        get() = if (isCotral) (if (rail) TransitVehicleKind.TRENO else TransitVehicleKind.BUS) else kind

    val operatorLabel: String
        get() = if (isCotral) (if (rail) "Cotral · treno" else "Cotral") else transitOperator.label

    /**
     * What a rider recognises: "Metro A", the bus/tram number ("64"), the rail line's name
     * ("METROMARE"). The backend's `displayName` is the long description for many Atac
     * lines, which would hide the number (lesson from iOS 2.0).
     */
    val title: String
        get() = when {
            isAtac && isMetro -> AtacMetroLine.fromShortName(shortName)?.friendlyName ?: displayName
            isAtac -> shortName
            rail -> longName.nonEmpty() ?: displayName
            else -> shortName
        }

    /** Long description under the title, unless it just repeats it. */
    val subtitleName: String?
        get() = longName.nonEmpty()?.takeIf { !it.equals(title, ignoreCase = true) }
}

/** Rome's 4 metro lines: the feed leaves `route_long_name` blank for all of them. */
enum class AtacMetroLine(val rawValue: String, val friendlyName: String) {
    A("MEA", "Metro A"),
    B("MEB", "Metro B"),
    B1("MEB1", "Metro B1"),
    C("MEC", "Metro C");

    companion object {
        fun fromShortName(shortName: String?): AtacMetroLine? = entries.firstOrNull { it.rawValue == shortName?.trim()?.uppercase() }
    }
}

/**
 * An Atac / Roma TPL stop (one platform: a station usually has one per direction). The
 * property names are the 1.0.0 ones: favorites saved by 1.0.0 decode unchanged.
 */
data class AtacStop(
    val stopId: String,
    val stopName: String,
    val lat: Double,
    val lon: Double,
    /** Where vehicles from this platform head (from `atac-stop` / `line`), labels the direction picker. */
    val headsign: String? = null,
) {
    val coordinate: LatLon get() = LatLon(lat, lon)
}

/** One physical station's platforms, grouped by name (never deduplicated — see [groupedStopsByName]). */
data class AtacStopGroup(val name: String, val stops: List<AtacStop>) {
    val id: String get() = "$name|${stops.firstOrNull()?.stopId ?: ""}"
    /** Deterministic representative platform (stops are sorted by stopId). */
    val anchor: AtacStop get() = stops[0]
}

/**
 * Groups stops by name, KEEPING every stop_id. A station is often split across several
 * stop_ids, one platform per direction, each with its own real-time arrivals — collapsing
 * them would throw a whole direction away. Order of first appearance is preserved (route
 * order for a `line`); platforms are sorted by id for a deterministic anchor.
 */
fun groupedStopsByName(stops: List<AtacStop>): List<AtacStopGroup> {
    val order = ArrayList<String>()
    val groups = HashMap<String, MutableList<AtacStop>>()
    for (stop in stops) {
        val key = stop.stopName.trim()
        if (key.isEmpty()) continue
        val list = groups.getOrPut(key) { order.add(key); ArrayList() }
        list.add(stop)
    }
    return order.map { name -> AtacStopGroup(name, groups.getValue(name).sortedBy { it.stopId }) }
}

/** Case-insensitive de-duplication by trimmed name, first occurrence wins (Cotral rail line station list). */
fun <T> List<T>.dedupedByName(name: (T) -> String): List<T> {
    val seen = HashSet<String>()
    return filter { val k = name(it).trim().lowercase(); k.isNotEmpty() && seen.add(k) }
}

/** A stop from `search` (either network). */
data class SearchStop(
    val source: String,
    val stopId: String,
    val name: String,
    val lat: Double,
    val lon: Double,
    val rail: Boolean,
    /** Atac metro station: no per-stop live data, so it can't be a reminder target. */
    val metro: Boolean,
) {
    val id: String get() = "$source:$stopId"
    val isCotral: Boolean get() = source == "cotral"
    val subtitle: String get() = if (isCotral) (if (rail) "Cotral · treno" else "Cotral") else "Atac / Roma TPL"
    val coordinate: LatLon get() = LatLon(lat, lon)

    fun asPole(): Pole = Pole.fromStop(stopId, name, null, lat, lon, rail)
    fun asAtacStop(): AtacStop = AtacStop(stopId, name, lat, lon)
}

data class SearchResults(val stops: List<SearchStop>, val routes: List<RouteInfo>) {
    companion object {
        val EMPTY = SearchResults(emptyList(), emptyList())
    }
}

/** Cotral poles + Atac stops inside a box (`stops`). */
data class ViewportStops(val poles: List<Pole>, val atacStops: List<AtacStop>)

/** A drawable line shape, decoded once. */
data class MapShape(
    val id: String,
    val routeId: String,
    val kind: TransitVehicleKind,
    val colorHex: String?,
    val points: List<LatLon>,
)

/** A stop in `line` / `atac-stop` responses. */
data class LineStop(val id: String, val name: String, val lat: Double, val lon: Double, val headsign: String?) {
    fun asAtacStop(): AtacStop = AtacStop(id, name, lat, lon, headsign)
}

/** `line`: the route, its stops (route order) and shapes. */
data class LineDetail(val route: RouteInfo, val stops: List<LineStop>, val shapes: List<MapShape>)

/** `lines`: every Atac line + the Cotral rail lines. */
data class LinesCatalog(val atac: List<RouteInfo>, val cotralRail: List<RouteInfo>)

/** One upcoming arrival at an Atac stop (`atac-live`, or the scheduled fallback `atac-schedule`). */
data class AtacArrival(
    val tripId: String,
    val routeId: String,
    val routeLabel: String,
    val kind: TransitVehicleKind,
    /** Unix seconds. */
    val ts: Long,
    /** Positive = late. Always null for a scheduled estimate. */
    val delaySeconds: Int?,
    val headsign: String?,
    val cancelled: Boolean,
) {
    val id: String get() = "$tripId|$ts"
    val timeLabel: String get() = RomeTime.hhmmFromUnix(ts)
    fun minutesFromNow(nowMillis: Long = System.currentTimeMillis()): Int = ((ts * 1000 - nowMillis) / 60_000L).toInt()
}

/** `atac-trip`: every stop of a run, past and future. */
data class AtacTrip(val tripId: String?, val routeId: String?, val routeLabel: String?, val headsign: String?, val stops: List<Stop>) {
    data class Stop(val stopId: String, val stopName: String, val sequence: Int, val ts: Long, val delaySeconds: Int?) {
        val id: String get() = "$stopId-$sequence"
    }
}

/** `pole?id=`: a Cotral stop with the ASTRAL direction codes of its rail line (empty for buses). */
data class PoleInfo(val id: String, val name: String?, val locality: String?, val lat: Double?, val lon: Double?, val rail: Boolean, val trainRoutes: List<String>)

/** `cotral-transits`. `pole == null` means Cotral has no data for this pole right now. */
data class CotralTransits(val pole: CotralPoleInfo?, val transits: List<Transit>)

/** `GET /health`. */
data class Health(val ok: Boolean, val version: String?, val gtfsReady: Boolean)

/** A single moving vehicle shown on the map, from either network. */
data class TransitVehicle(
    /** "atac-<vid>" / "cotral-<code>". */
    val id: String,
    val coordinate: LatLon,
    val bearing: Double?,
    /** Atac: GTFS route_id. Cotral: the `percorso` of the run that surfaced it (an ASTRAL code for a train). */
    val routeId: String?,
    val routeLabel: String?,
    val kind: TransitVehicleKind,
    val transitOperator: TransitOperator,
    /** Seconds of delay, only when a real-time source reliably reported one (Cotral). */
    val delaySeconds: Int?,
    val tripId: String?,
    val headsign: String?,
    /** Cotral vehicle code (for "Segui"). */
    val vehicleCode: String?,
) {
    /** What the vehicle sheet calls the line: the train line's name, "Metro A", the bus number. */
    val lineLabel: String
        get() {
            if (transitOperator == TransitOperator.COTRAL) {
                CotralTrainRoute.fromRaw(routeId)?.let { return it.lineName }
                return routeLabel ?: "—"
            }
            return AtacMetroLine.fromShortName(routeLabel)?.friendlyName ?: routeLabel ?: "—"
        }
}

/**
 * A favorited stop from either operator. Cotral's `Pole` and Atac's `AtacStop` are
 * unrelated id spaces, so ids are namespaced ("cotral:" / "atac:") — same as 1.0.0, iOS
 * and the web app.
 */
sealed interface FavoriteStop {
    val id: String
    val displayName: String
    val subtitle: String?

    data class Cotral(val pole: Pole) : FavoriteStop {
        override val id get() = "cotral:${pole.id}"
        override val displayName get() = pole.displayName
        override val subtitle get() = pole.subtitle
    }

    data class Atac(val stop: AtacStop) : FavoriteStop {
        override val id get() = "atac:${stop.stopId}"
        override val displayName get() = stop.stopName
        override val subtitle get() = "Atac / Roma TPL"
    }
}
