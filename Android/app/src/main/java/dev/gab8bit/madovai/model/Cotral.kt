package dev.gab8bit.madovai.model

import kotlin.math.abs

/**
 * A Cotral "palina" (bus pole or rail station).
 *
 * The property names are the 1.0.0 ones on purpose: favorites saved by 1.0.0 store a
 * serialized Pole and decode unchanged (see FavoritesStore). `codicePalina` is the GTFS
 * `stop_id` ("f3583", "RL_ACILIA"), which is exactly the id every backend endpoint expects
 * (`cotral-transits?pole=`, `pole?id=`, `rail?stop=`) — 1.0.0 also used the raw GTFS
 * `stop_id`, so 1.0.0 favorites keep matching without any id migration.
 */
data class Pole(
    val codicePalina: String? = null,
    val codiceStop: String? = null,
    val nomePalina: String? = null,
    val nomeStop: String? = null,
    val localita: String? = null,
    val comune: String? = null,
    /** Latitude. */
    val coordX: Double? = null,
    /** Longitude. */
    val coordY: Double? = null,
    /** A rail station (Metromare / Roma-Viterbo), not a bus pole. */
    val isTreno: Boolean = false,
) {
    /** Stable identity: codicePalina, then codiceStop, then coordinates. */
    val id: String
        get() = codicePalina ?: codiceStop ?: "${coordX ?: 0.0},${coordY ?: 0.0}"

    /** The id the backend wants. */
    val code: String? get() = codicePalina.nonEmpty() ?: codiceStop.nonEmpty()

    val coordinate: LatLon?
        get() {
            val lat = coordX ?: return null
            val lon = coordY ?: return null
            return LatLon(lat, lon).takeIf { it.isValidForMap }
        }

    val displayName: String
        get() = nomePalina.nonEmpty() ?: nomeStop.nonEmpty() ?: localita.nonEmpty() ?: "Palina ${code ?: ""}"

    val subtitle: String?
        get() = comune.nonEmpty() ?: localita.nonEmpty()

    /**
     * PIV.do's own pole info (`cotral-transits` → `pole`) is often sparser than the static
     * one: keep whichever value each field already has. The code always stays the static
     * one — PIV.do's `codice` is another id namespace; letting it win once produced
     * duplicate favorites.
     */
    fun merged(info: CotralPoleInfo): Pole = copy(
        nomePalina = info.name.nonEmpty() ?: nomePalina,
        nomeStop = info.stopName.nonEmpty() ?: nomeStop,
        localita = info.locality.nonEmpty() ?: localita,
        comune = info.comune.nonEmpty() ?: comune,
        coordX = if (info.lat != null && info.lon != null && LatLon(info.lat, info.lon).isValidForMap) info.lat else coordX,
        coordY = if (info.lat != null && info.lon != null && LatLon(info.lat, info.lon).isValidForMap) info.lon else coordY,
    )

    companion object {
        /** A pole/station from a static stop (stops / search / line endpoints). */
        fun fromStop(id: String, name: String, locality: String?, lat: Double?, lon: Double?, rail: Boolean) = Pole(
            codicePalina = id,
            codiceStop = id,
            nomePalina = name,
            nomeStop = name,
            localita = locality.nonEmpty() ?: StopText.locality(name),
            coordX = lat,
            coordY = lon,
            isTreno = rail,
        )
    }
}

/** PIV.do's description of a pole, as `cotral-transits` returns it. */
data class CotralPoleInfo(
    val code: String?,
    val name: String?,
    val stopName: String?,
    val locality: String?,
    val comune: String?,
    val lat: Double?,
    val lon: Double?,
)

enum class TransitTrackingStatus {
    /** `monitorata == "1"` and the assigned vehicle is currently transmitting. */
    REALTIME,
    /** `monitorata == "1"` but the assigned vehicle isn't transmitting right now. */
    MONITORED_OFFLINE,
    /** `monitorata != "1"` — schedule-only, no live tracking possible for this run. */
    SCHEDULED,
}

/** A run passing a Cotral pole (`cotral-transits`). Field names are the backend's (= PIV.do's). */
data class Transit(
    val idCorsa: String,
    val percorso: String,
    val partenzaCorsa: String,
    val orarioPartenzaCorsa: String,
    val arrivoCorsa: String,
    val orarioArrivoCorsa: String,
    val soppressa: String,
    val tempoTransito: String,
    /** Seconds (negative = early). Only meaningful when [trackingStatus] is REALTIME; Cotral sends a fictitious 0 otherwise. */
    val ritardoSeconds: Int,
    val vehicleCode: String?,
    val vehicleAlive: Boolean,
    val instradamento: String,
    val banchina: String,
    /** "1" when this run supports real-time tracking. */
    val monitorata: String,
) {
    val id: String get() = idCorsa.ifEmpty { "$partenzaCorsa-$arrivoCorsa-$orarioPartenzaCorsa" }

    val trackingStatus: TransitTrackingStatus
        get() = when {
            monitorata != "1" -> TransitTrackingStatus.SCHEDULED
            vehicleAlive -> TransitTrackingStatus.REALTIME
            else -> TransitTrackingStatus.MONITORED_OFFLINE
        }

    val isDelayReliable: Boolean get() = trackingStatus == TransitTrackingStatus.REALTIME

    val isCancelled: Boolean get() = soppressa.trim().uppercase() == "Y"

    val canTrackVehicle: Boolean get() = monitorata == "1" && !vehicleCode.isNullOrBlank()

    val displayTime: String get() = tempoTransito.ifEmpty { orarioPartenzaCorsa }

    /** [displayTime] corrected for a reliable delay (≥ 60 s), wrapped to a 24 h clock face. */
    val adjustedDisplayTime: String
        get() = if (!isDelayReliable || abs(ritardoSeconds) < 60) displayTime else applyingDelay(displayTime, ritardoSeconds)

    /**
     * Minutes from now until the delay-aware arrival. Backs the "tra N min" label, the sort
     * order AND the "already passed" filter — a run a couple of minutes late must not look
     * "passed" just because its timetable time ticked by.
     */
    fun minutesFromNow(nowMillis: Long = System.currentTimeMillis()): Int? = RomeTime.minutesFromNow(adjustedDisplayTime, nowMillis)

    companion object {
        fun applyingDelay(time: String, ritardoSeconds: Int): String {
            val parts = time.split(":")
            if (parts.size != 2) return time
            val h = parts[0].trim().toIntOrNull() ?: return time
            val m = parts[1].trim().toIntOrNull() ?: return time
            val total = h * 3600 + m * 60 + ritardoSeconds
            val wrapped = ((total % 86400) + 86400) % 86400
            return "%02d:%02d".format(java.util.Locale.ROOT, wrapped / 3600, (wrapped % 3600) / 60)
        }

        /**
         * What the pole sheet lists: runs whose (delay-aware) arrival passed more than ~2 min ago
         * are stale (Cotral's feed can get stuck reporting one forever) and dropped; soonest first.
         */
        fun upcomingForSheet(transits: List<Transit>, nowMillis: Long = System.currentTimeMillis()): List<Transit> =
            transits
                .filter { (it.minutesFromNow(nowMillis) ?: 0) >= -2 }
                .sortedBy { it.minutesFromNow(nowMillis) ?: Int.MAX_VALUE }
    }
}

/** One scheduled passage at a Cotral rail station (ASTRAL, or the static-GTFS fallback). */
data class AstralDeparture(
    val id: String,
    /** "HH:mm" at this station. */
    val time: String,
    /** Seconds since midnight (Rome) — the sort key. */
    val sortSeconds: Int,
    /** Whole minutes; null when unknown (always null in the static-GTFS fallback). */
    val delayMinutes: Int?,
    val isCancelled: Boolean,
    val isReplacementBus: Boolean,
)

/** ASTRAL and the GTFS fallback return the whole day: keep what's still ahead, soonest first. */
fun List<AstralDeparture>.upcoming(nowMillis: Long = System.currentTimeMillis()): List<AstralDeparture> {
    val nowSeconds = RomeTime.secondsSinceMidnight(nowMillis)
    return filter { it.sortSeconds >= nowSeconds }.sortedBy { it.sortSeconds }
}

/** One direction of a rail station's schedule (`rail`). `route` is null for the static-GTFS fallback. */
data class AstralScheduleDirection(val destination: String, val route: String?, val entries: List<AstralDeparture>)

/** `rail?stop=`: "astral" (real time), "gtfs" (timetable only) or "none". */
data class RailSchedule(val source: String, val directions: List<AstralScheduleDirection>) {
    companion object {
        /**
         * RVEXT has two direction pairs (Viterbo↔Catalano and Morlupo↔Catalano) that can both
         * head to "Catalano" at a shared station — one tab per destination for the rider.
         */
        fun mergeSameDestination(directions: List<AstralScheduleDirection>): List<AstralScheduleDirection> =
            directions.groupBy { it.destination }.map { (destination, group) ->
                if (group.size == 1) group[0]
                else AstralScheduleDirection(destination, group[0].route, group.flatMap { it.entries }.distinctBy { it.id to it.time }.sortedBy { it.sortSeconds })
            }.sortedBy { it.destination }
    }
}

/** `astral-line`: every station of a rail direction with its next passage. */
data class AstralLine(val route: String, val directionLabel: String?, val lineName: String?, val stations: List<Station>) {
    data class Station(val name: String, val code: String?, val order: Int?, val next: AstralDeparture?) {
        val id: String get() = code ?: name
    }
}

/**
 * ASTRAL's `codicePercorso` values — one per direction of each rail line. A separate id
 * space from PIV.do and from GTFS `route_id`s; a Cotral train's `percorso` is one of these.
 */
enum class CotralTrainRoute(
    val rawValue: String,
    val lineName: String,
    val directionLabel: String,
    val destinationName: String,
    val gtfsRouteShortName: String,
) {
    METROMARE_COLOMBO_TO_PSP("RL_CC-PSP", "Metromare", "Cristoforo Colombo → Porta San Paolo", "Porta San Paolo", "ROMALIDO"),
    METROMARE_PSP_TO_COLOMBO("RL_PSP-CC", "Metromare", "Porta San Paolo → Cristoforo Colombo", "Cristoforo Colombo", "ROMALIDO"),
    VITERBO_URBANA_FLAMINIO_TO_MONTEBELLO("RN_RMMON", "Roma-Viterbo Urbana", "Flaminio → Montebello", "Montebello", "RVURB"),
    VITERBO_URBANA_MONTEBELLO_TO_FLAMINIO("RN_MONRM", "Roma-Viterbo Urbana", "Montebello → Flaminio", "Flaminio", "RVURB"),
    VITERBO_EXTRA_CATALANO_TO_VITERBO("RV_CATVIT", "Roma-Viterbo Extraurbana", "Catalano → Viterbo", "Viterbo", "RVEXT"),
    VITERBO_EXTRA_VITERBO_TO_CATALANO("RV_VITCAT", "Roma-Viterbo Extraurbana", "Viterbo → Catalano", "Catalano", "RVEXT"),
    MORLUPO_TO_CATALANO("RV_MORCAT", "Roma-Viterbo Extraurbana", "Morlupo → Catalano", "Catalano", "RVEXT"),
    CATALANO_TO_MORLUPO("RV_CATMOR", "Roma-Viterbo Extraurbana", "Catalano → Morlupo", "Morlupo", "RVEXT");

    companion object {
        fun fromRaw(raw: String?): CotralTrainRoute? = if (raw == null) null else entries.firstOrNull { it.rawValue == raw.trim() }

        /** Every direction of the line a GTFS rail route (by `route_short_name`) belongs to. */
        fun directionsForGtfsRouteShortName(shortName: String?): List<CotralTrainRoute> =
            entries.filter { it.gtfsRouteShortName == shortName?.trim()?.uppercase() }
    }
}
