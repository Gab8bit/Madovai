package dev.gab8bit.madovai.model

import org.json.JSONArray
import org.json.JSONObject
import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZonedDateTime
import java.util.UUID

/**
 * Weekday ids exactly as the web app, iOS and the backend store them: Apple's Calendar
 * numbering, **1 = Sunday … 7 = Saturday**, shown Monday-first.
 */
enum class Weekday(val id: Int, val shortLabel: String) {
    SUNDAY(1, "Dom"),
    MONDAY(2, "Lun"),
    TUESDAY(3, "Mar"),
    WEDNESDAY(4, "Mer"),
    THURSDAY(5, "Gio"),
    FRIDAY(6, "Ven"),
    SATURDAY(7, "Sab");

    companion object {
        val mondayFirst: List<Weekday> = listOf(MONDAY, TUESDAY, WEDNESDAY, THURSDAY, FRIDAY, SATURDAY, SUNDAY)
        fun fromId(id: Int): Weekday? = entries.firstOrNull { it.id == id }

        /** java.time Monday=1…Sunday=7 → Apple Sunday=1…Saturday=7. */
        fun of(day: DayOfWeek): Weekday = fromId(day.value % 7 + 1)!!
    }
}

/** Which live source a reminder targets, plus the id that source needs at check time. Same JSON as the web app. */
sealed interface ReminderSource {
    /** `poleCode`: the Cotral GTFS stop id (a pole is already directional). */
    data class CotralBus(val poleCode: String) : ReminderSource

    /**
     * A Cotral rail station needs an explicit direction (ASTRAL schedules are per line +
     * direction). `stopId` (e.g. "RL_ACILIA") lets the check use the backend's `rail`
     * endpoint, like iOS 2.0; without it the check falls back to `astral-line`.
     */
    data class CotralTrain(val stationName: String, val route: CotralTrainRoute, val stopId: String?) : ReminderSource

    /** An Atac GTFS stop id (one per platform/direction). Metro stations are excluded at the form level. */
    data class AtacStop(val stopId: String) : ReminderSource

    val isTrain: Boolean get() = this is CotralTrain
}

/**
 * A Promemoria: at [hour]:[minute] (Rome time) on [weekdays] the phone asks the backend for
 * the next departure and posts a local notification. Same shape as the web/iOS/backend
 * Reminder, plus Android's own [enabled] switch (absent = enabled, so other clients'
 * JSON reads fine).
 */
data class Reminder(
    val id: String = UUID.randomUUID().toString(),
    val stopName: String,
    val weekdays: Set<Weekday>,
    val hour: Int,
    val minute: Int,
    val source: ReminderSource,
    val enabled: Boolean = true,
) {
    val timeLabel: String get() = "%02d:%02d".format(java.util.Locale.ROOT, hour, minute)

    val weekdaysLabel: String
        get() = if (weekdays.size == 7) "Tutti i giorni" else Weekday.mondayFirst.filter { it in weekdays }.joinToString(" · ") { it.shortLabel }

    /** Rules of the backend's validation: hour 0–23, minute 0–59, at least one weekday. */
    val isValid: Boolean get() = hour in 0..23 && minute in 0..59 && weekdays.isNotEmpty() && stopName.isNotBlank()

    /**
     * The next time this reminder fires strictly after [afterMillis], in Rome time (the hour
     * the user picked is a Rome departure time). DST gaps resolve forward like Calendar's
     * `.nextTime` policy. Null when no weekday is selected.
     */
    fun nextFireMillis(afterMillis: Long): Long? {
        if (weekdays.isEmpty() || hour !in 0..23 || minute !in 0..59) return null
        val after: ZonedDateTime = Instant.ofEpochMilli(afterMillis).atZone(RomeTime.zone)
        var date: LocalDate = after.toLocalDate()
        repeat(8) {
            if (Weekday.of(date.dayOfWeek) in weekdays) {
                val candidate = ZonedDateTime.of(date, LocalTime.of(hour, minute), RomeTime.zone)
                val millis = candidate.toInstant().toEpochMilli()
                if (millis > afterMillis) return millis
            }
            date = date.plusDays(1)
        }
        return null
    }

    fun toJson(): JSONObject = JSONObject().apply {
        put("id", id)
        put("stopName", stopName)
        put("weekdays", JSONArray(weekdays.map { it.id }.sorted()))
        put("hour", hour)
        put("minute", minute)
        put("source", when (source) {
            is ReminderSource.CotralBus -> JSONObject().put("type", "cotralBus").put("poleCode", source.poleCode)
            is ReminderSource.CotralTrain -> JSONObject().put("type", "cotralTrain").put("stationName", source.stationName)
                .put("route", source.route.rawValue).apply { source.stopId?.let { put("stopId", it) } }
            is ReminderSource.AtacStop -> JSONObject().put("type", "atacStop").put("stopId", source.stopId)
        })
        put("enabled", enabled)
    }

    companion object {
        /** Tolerant decoding (unknown sources/garbage → null, never a crash). */
        fun fromJson(o: JSONObject): Reminder? {
            val id = o.optString("id").trim().takeIf { it.isNotEmpty() } ?: return null
            val s = o.optJSONObject("source") ?: return null
            fun str(obj: JSONObject, k: String): String? = if (obj.isNull(k)) null else obj.optString(k).trim().takeIf { it.isNotEmpty() }
            val source: ReminderSource = when (str(s, "type")) {
                "cotralBus" -> ReminderSource.CotralBus(str(s, "poleCode") ?: return null)
                "cotralTrain" -> ReminderSource.CotralTrain(
                    stationName = str(s, "stationName") ?: return null,
                    route = CotralTrainRoute.fromRaw(str(s, "route")) ?: return null,
                    stopId = str(s, "stopId"),
                )
                "atacStop" -> ReminderSource.AtacStop(str(s, "stopId") ?: return null)
                else -> return null
            }
            val days = o.optJSONArray("weekdays")?.let { a -> (0 until a.length()).mapNotNull { Weekday.fromId(a.optInt(it, -1)) }.toSet() } ?: emptySet()
            return Reminder(
                id = id,
                stopName = str(o, "stopName") ?: "",
                weekdays = days,
                hour = o.optInt("hour", -1),
                minute = o.optInt("minute", -1),
                source = source,
                enabled = o.optBoolean("enabled", true),
            )
        }

        fun listToJson(list: List<Reminder>): String = JSONArray(list.map { it.toJson() }).toString()

        fun listFromJson(json: String?): List<Reminder> {
            if (json.isNullOrBlank()) return emptyList()
            return runCatching {
                val a = JSONArray(json)
                val seen = HashSet<String>()
                (0 until a.length()).mapNotNull { i -> a.optJSONObject(i)?.let(::fromJson) }.filter { seen.add(it.id) }
            }.getOrDefault(emptyList())
        }
    }
}

/**
 * A single "next departure" reading for a reminder, normalised across the three sources —
 * same rules as the backend's `departureStatus.ts` and iOS `ReminderDepartureStatus`, so
 * the local notification reads exactly like the web app's push.
 */
data class ReminderDepartureStatus(
    /** "HH:mm", for the notification title. */
    val time: String,
    /** null = unknown, 0 = on time, > 0 = late. Never negative: an early run isn't worth flagging. */
    val delayMinutes: Int?,
    val isCancelled: Boolean,
    /** Only when [isCancelled]: the following departure ("Prossimo utile"). */
    val nextUsefulTime: String?,
) {
    private data class Item(val time: String, val delayMinutes: Int?, val isCancelled: Boolean)

    companion object {
        private fun combine(items: List<Item>): ReminderDepartureStatus? {
            val first = items.firstOrNull() ?: return null
            return ReminderDepartureStatus(first.time, first.delayMinutes, first.isCancelled, if (first.isCancelled) items.getOrNull(1)?.time else null)
        }

        /** Cotral bus: next not-yet-passed runs (delay-aware), soonest first; ties keep the feed's order. */
        fun fromTransits(transits: List<Transit>, nowMillis: Long = System.currentTimeMillis()): ReminderDepartureStatus? =
            combine(
                transits.withIndex()
                    .mapNotNull { (i, t) -> t.minutesFromNow(nowMillis)?.takeIf { it >= 0 }?.let { Triple(it, i, t) } }
                    .sortedWith(compareBy({ it.first }, { it.second }))
                    .map { (_, _, t) ->
                        // Integer division truncates toward zero like Swift's `/` and the backend's Math.trunc.
                        Item(t.adjustedDisplayTime, if (t.isDelayReliable) maxOf(0, t.ritardoSeconds / 60) else null, t.isCancelled)
                    },
            )

        /** Cotral rail: [entries] must already be upcoming-only, soonest first. */
        fun fromAstral(entries: List<AstralDeparture>): ReminderDepartureStatus? =
            combine(entries.map { Item(it.time, it.delayMinutes?.let { d -> maxOf(0, d) }, it.isCancelled) })

        /** Atac bus/tram: arrivals from now on, soonest first. */
        fun fromAtac(arrivals: List<AtacArrival>, nowMillis: Long = System.currentTimeMillis()): ReminderDepartureStatus? {
            val nowTs = nowMillis / 1000
            return combine(
                arrivals.filter { it.ts >= nowTs }.sortedBy { it.ts }
                    .map { Item(it.timeLabel, it.delaySeconds?.let { d -> maxOf(0, d / 60) }, it.cancelled) },
            )
        }
    }
}

/** Notification texts — a literal port of the backend's `push/notifier.ts` (itself the iOS `ReminderNotifier`). */
object ReminderTexts {
    data class Content(val title: String, val body: String)

    fun content(reminder: Reminder, status: ReminderDepartureStatus): Content {
        val source = reminder.source
        val vehicle = if (source.isTrain) "treno" else "bus"
        var target = "per ${reminder.stopName}"
        if (source is ReminderSource.CotralTrain) target += ", direzione ${source.route.directionLabel}"

        val body = if (status.isCancelled) {
            val next = status.nextUsefulTime
            val fallback = if (!next.isNullOrEmpty()) " Prossimo utile: $next." else " Nessun'altra corsa in programma."
            "Il prossimo $vehicle $target è stato soppresso.$fallback"
        } else {
            val delay = status.delayMinutes
            if (delay == null || delay < 1) "Il prossimo $vehicle $target non fa ritardo."
            else "Il prossimo $vehicle $target è in ritardo di $delay minut${if (delay == 1) "o" else "i"}."
        }
        return Content("Prossimo $vehicle alle ${status.time}", body)
    }

    /** The test notification (same texts as the backend's `testPayload`). */
    val test = Content("Notifiche attive", "I promemoria di Madovai ti avviseranno su questo dispositivo.")
}
