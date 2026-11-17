package dev.gab8bit.madovai.model

import dev.gab8bit.madovai.Config
import java.time.Instant
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import kotlin.math.abs

data class LatLon(val latitude: Double, val longitude: Double) {
    fun isApproximately(other: LatLon?, tolerance: Double = 0.0000005): Boolean {
        if (other == null) return false
        return abs(latitude - other.latitude) < tolerance && abs(longitude - other.longitude) < tolerance
    }

    /** (0,0) and out-of-range values are "no fix", never a real place in Lazio. */
    val isValidForMap: Boolean
        get() = latitude in -90.0..90.0 && longitude in -180.0..180.0 && !(latitude == 0.0 && longitude == 0.0)
}

/**
 * Which agency a piece of data belongs to. Cotral covers extra-urban Lazio; Atac and
 * Roma TPL together cover urban Rome — shown together on one map but never conflated.
 */
enum class TransitOperator(val label: String) {
    COTRAL("Cotral"),
    ATAC("Atac"),
    ROMA_TPL("Roma TPL");

    companion object {
        /** The backend's `operator` field ("Cotral" | "Atac" | "Roma TPL"). */
        fun fromApi(value: String?): TransitOperator? = entries.firstOrNull { it.label.equals(value?.trim(), ignoreCase = true) }
    }
}

/** The backend's `kind`: "bus" | "tram" | "metro" | "treno" (GTFS route_type 3/0/1/2). */
enum class TransitVehicleKind(val apiValue: String) {
    BUS("bus"),
    TRAM("tram"),
    METRO("metro"),
    TRENO("treno");

    companion object {
        fun fromApi(value: String?): TransitVehicleKind? = entries.firstOrNull { it.apiValue == value?.trim()?.lowercase() }
    }
}

/** A lat/lon bounding box of the settled map viewport. */
data class ViewportBounds(val minLat: Double, val maxLat: Double, val minLon: Double, val maxLon: Double) {
    /** Padded beyond the visible edges so a small pan doesn't immediately show empty edges (same as the web's `pad`). */
    val padded: ViewportBounds
        get() {
            val latPad = (maxLat - minLat) * 0.15 + 0.01
            val lonPad = (maxLon - minLon) * 0.15 + 0.01
            return ViewportBounds(minLat - latPad, maxLat + latPad, minLon - lonPad, maxLon + lonPad)
        }

    fun contains(point: LatLon): Boolean =
        point.latitude in minLat..maxLat && point.longitude in minLon..maxLon
}

/** The settled map camera: what was visible and at which zoom. */
data class MapViewport(val bounds: ViewportBounds, val zoom: Double) {
    val showsData: Boolean get() = zoom >= Config.MIN_DATA_ZOOM
}

sealed interface VehicleTrackingState {
    /** Not following any vehicle right now. */
    data object Idle : VehicleTrackingState
    /** Actively polling and receiving fresh positions. */
    data object Tracking : VehicleTrackingState
    /** The followed vehicle stopped transmitting — surfaced explicitly, never a silently frozen marker. */
    data class Lost(val lastUpdateMillis: Long?) : VehicleTrackingState
}

/**
 * Everything "now" is Rome wall-clock time: Cotral/ASTRAL/GTFS times are Rome local, so a
 * phone set to another time zone must still see consistent "tra N min" labels.
 */
object RomeTime {
    val zone: ZoneId = ZoneId.of("Europe/Rome")
    private val hhmmFormat: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm")

    fun now(millis: Long = System.currentTimeMillis()): ZonedDateTime = Instant.ofEpochMilli(millis).atZone(zone)

    /** "HH:mm" in Rome for epoch millis. */
    fun hhmm(millis: Long): String = now(millis).format(hhmmFormat)

    /** "HH:mm" in Rome for unix seconds (the backend's `ts`). */
    fun hhmmFromUnix(seconds: Long): String = hhmm(seconds * 1000)

    fun minutesSinceMidnight(millis: Long = System.currentTimeMillis()): Int {
        val t = now(millis)
        return t.hour * 60 + t.minute
    }

    fun secondsSinceMidnight(millis: Long = System.currentTimeMillis()): Int {
        val t = now(millis)
        return t.hour * 3600 + t.minute * 60 + t.second
    }

    /**
     * Minutes from now until an "HH:MM" Rome time, with the schedules' own midnight-rollover
     * convention (a single ±12 h wrap, so "00:10" seen at 23:50 is in 20 minutes, and
     * "25:10" style post-midnight times still work).
     */
    fun minutesFromNow(time: String, nowMillis: Long = System.currentTimeMillis()): Int? {
        val parts = time.trim().split(":")
        if (parts.size != 2) return null
        val h = parts[0].toIntOrNull() ?: return null
        val m = parts[1].toIntOrNull() ?: return null
        var diff = h * 60 + m - minutesSinceMidnight(nowMillis)
        if (diff > 12 * 60) diff -= 24 * 60
        if (diff < -12 * 60) diff += 24 * 60
        return diff
    }
}

/** Google's Encoded Polyline Algorithm, precision 5 (the backend's `coords`). */
object Polyline {
    fun decode(encoded: String): List<LatLon> {
        val points = ArrayList<LatLon>(encoded.length / 4)
        var index = 0
        var lat = 0
        var lon = 0
        while (index < encoded.length) {
            for (axis in 0..1) {
                var result = 0
                var shift = 0
                var byte: Int
                do {
                    if (index >= encoded.length) return points
                    byte = encoded[index++].code - 63
                    result = result or ((byte and 0x1f) shl shift)
                    shift += 5
                } while (byte >= 0x20)
                val delta = if (result and 1 != 0) (result shr 1).inv() else result shr 1
                if (axis == 0) lat += delta else lon += delta
            }
            points.add(LatLon(lat / 1e5, lon / 1e5))
        }
        return points
    }
}

/** Display text helpers shared by the sheets and the reminder notifications. */
object StopText {
    /** "ARTENA | Campo Sportivo (f123)" → "ARTENA": the part before `| ! (` (GTFSTextUtils.extractLocality). */
    fun locality(name: String?): String = (name ?: "").split('|', '!', '(').first().trim()
}

fun String?.nonEmpty(): String? = this?.trim()?.takeIf { it.isNotEmpty() }
