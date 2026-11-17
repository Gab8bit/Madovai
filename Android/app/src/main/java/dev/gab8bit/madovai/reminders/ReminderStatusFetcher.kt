package dev.gab8bit.madovai.reminders

import dev.gab8bit.madovai.api.MadovaiApi
import dev.gab8bit.madovai.model.AstralScheduleDirection
import dev.gab8bit.madovai.model.CotralTrainRoute
import dev.gab8bit.madovai.model.Reminder
import dev.gab8bit.madovai.model.ReminderDepartureStatus
import dev.gab8bit.madovai.model.ReminderSource
import dev.gab8bit.madovai.model.upcoming
import java.text.Normalizer

/**
 * "What is the next departure for this reminder", asked to the backend at reminder time —
 * the same logic as the backend's `departureStatus.ts` (which serves the web app's push)
 * and iOS `ReminderStatusFetcher`.
 *
 * Returns null when there's nothing upcoming; throws on network/server failure. The
 * scheduler treats both as "no notification, retry in 2 minutes".
 */
class ReminderStatusFetcher(private val api: MadovaiApi) {

    suspend fun status(reminder: Reminder, nowMillis: Long = System.currentTimeMillis()): ReminderDepartureStatus? =
        when (val source = reminder.source) {
            is ReminderSource.CotralBus ->
                ReminderDepartureStatus.fromTransits(api.cotralTransits(source.poleCode).transits, nowMillis)

            is ReminderSource.CotralTrain -> {
                val stopId = source.stopId
                if (stopId != null) {
                    val direction = direction(source.route, api.rail(stopId).directions)
                    direction?.let { ReminderDepartureStatus.fromAstral(it.entries.upcoming(nowMillis)) }
                } else {
                    // A reminder without the station id (e.g. created by another client): the
                    // line-wide ASTRAL view only knows each station's next train, so a
                    // cancellation can't name the following one here.
                    val line = api.astralLine(source.route.rawValue)
                    val next = line.stations.firstOrNull { sameName(it.name, source.stationName) }?.next
                    next?.let { ReminderDepartureStatus.fromAstral(listOf(it).upcoming(nowMillis)) }
                }
            }

            is ReminderSource.AtacStop ->
                ReminderDepartureStatus.fromAtac(api.atacLive(listOf(source.stopId))[source.stopId] ?: emptyList(), nowMillis)
        }

    companion object {
        /** The `rail` direction matching the reminder's route: by route code when present, else by destination name. */
        fun direction(route: CotralTrainRoute, directions: List<AstralScheduleDirection>): AstralScheduleDirection? =
            directions.firstOrNull { it.route == route.rawValue } ?: directions.firstOrNull { sameName(it.destination, route.destinationName) }

        /** Case- and accent-insensitive comparison of trimmed names. */
        fun sameName(a: String, b: String): Boolean = fold(a) == fold(b)

        private fun fold(s: String): String =
            Normalizer.normalize(s.trim(), Normalizer.Form.NFD).replace(Regex("\\p{M}+"), "").lowercase()
    }
}
