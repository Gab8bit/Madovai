package dev.gab8bit.madovai.reminders

import dev.gab8bit.madovai.Config
import dev.gab8bit.madovai.Fixtures
import dev.gab8bit.madovai.api.ApiClient
import dev.gab8bit.madovai.api.ApiException
import dev.gab8bit.madovai.api.Json
import dev.gab8bit.madovai.api.MadovaiApi
import dev.gab8bit.madovai.model.AstralDeparture
import dev.gab8bit.madovai.model.AtacArrival
import dev.gab8bit.madovai.model.CotralTrainRoute
import dev.gab8bit.madovai.model.Reminder
import dev.gab8bit.madovai.model.ReminderDepartureStatus
import dev.gab8bit.madovai.model.ReminderSource
import dev.gab8bit.madovai.model.ReminderTexts
import dev.gab8bit.madovai.model.Transit
import dev.gab8bit.madovai.model.TransitVehicleKind
import dev.gab8bit.madovai.model.Weekday
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class ReminderTest {
    private val weekdaysMonFri = setOf(Weekday.MONDAY, Weekday.TUESDAY, Weekday.WEDNESDAY, Weekday.THURSDAY, Weekday.FRIDAY)

    private fun reminder(source: ReminderSource, days: Set<Weekday> = weekdaysMonFri, hour: Int = 7, minute: Int = 30, name: String = "Acilia") =
        Reminder("r1", name, days, hour, minute, source)

    // region model + JSON

    @Test fun decodesTheWebAppsJson() {
        // Exactly what Madovai Web stores in localStorage (and iOS / the backend accept).
        val web = """[{"id":"6f1c","stopName":"Acilia","weekdays":[2,3,4],"hour":7,"minute":30,"source":{"type":"cotralTrain","stationName":"Acilia","route":"RL_PSP-CC"}},
            {"id":"a2","stopName":"ANAGNINA (MA)","weekdays":[1,7],"hour":22,"minute":5,"source":{"type":"atacStop","stopId":"05019"}},
            {"id":"b3","stopName":"Anagnina Metro A","weekdays":[2],"hour":0,"minute":0,"source":{"type":"cotralBus","poleCode":"f3583"}},
            {"id":"bad","stopName":"x","weekdays":[2],"hour":1,"minute":1,"source":{"type":"nope"}}]"""
        val list = Reminder.listFromJson(web)
        assertEquals(3, list.size)
        val train = list[0]
        assertEquals(setOf(Weekday.MONDAY, Weekday.TUESDAY, Weekday.WEDNESDAY), train.weekdays)
        assertEquals(ReminderSource.CotralTrain("Acilia", CotralTrainRoute.METROMARE_PSP_TO_COLOMBO, null), train.source)
        assertTrue(train.enabled)
        assertEquals(setOf(Weekday.SUNDAY, Weekday.SATURDAY), list[1].weekdays)
        assertEquals("Sab · Dom", list[1].weekdaysLabel)
        assertEquals("22:05", list[1].timeLabel)
        assertEquals(ReminderSource.CotralBus("f3583"), list[2].source)
    }

    @Test fun encodesTheSameShapeAndRoundTrips() {
        val r = Reminder("id-1", "Acilia", setOf(Weekday.FRIDAY, Weekday.MONDAY), 7, 5, ReminderSource.CotralTrain("Acilia", CotralTrainRoute.METROMARE_COLOMBO_TO_PSP, "RL_ACILIA"), enabled = false)
        val o = r.toJson()
        assertEquals("[2,6]", o.getJSONArray("weekdays").toString())
        val s = o.getJSONObject("source")
        assertEquals("cotralTrain", s.getString("type"))
        assertEquals("RL_CC-PSP", s.getString("route"))
        assertEquals("RL_ACILIA", s.getString("stopId"))
        assertEquals(listOf(r), Reminder.listFromJson(Reminder.listToJson(listOf(r))))
        assertEquals("Lun · Ven", r.weekdaysLabel)
        assertEquals("Tutti i giorni", r.copy(weekdays = Weekday.entries.toSet()).weekdaysLabel)
    }

    @Test fun nextFireIsInRomeTimeOnTheChosenWeekdays() {
        val r = reminder(ReminderSource.AtacStop("1"))
        // Tuesday 17 Nov 2026, 07:00 Rome → same day 07:30.
        assertEquals(Fixtures.rome(2026, 11, 17, 7, 30), r.nextFireMillis(Fixtures.rome(2026, 11, 17, 7, 0)))
        // Exactly at 07:30 → strictly after: Wednesday.
        assertEquals(Fixtures.rome(2026, 11, 18, 7, 30), r.nextFireMillis(Fixtures.rome(2026, 11, 17, 7, 30)))
        // Friday evening → Monday.
        assertEquals(Fixtures.rome(2026, 11, 23, 7, 30), r.nextFireMillis(Fixtures.rome(2026, 11, 20, 20, 0)))
        // Sunday only (id 1).
        val sunday = r.copy(weekdays = setOf(Weekday.SUNDAY))
        assertEquals(Fixtures.rome(2026, 11, 22, 7, 30), sunday.nextFireMillis(Fixtures.rome(2026, 11, 17, 7, 0)))
        assertNull(r.copy(weekdays = emptySet()).nextFireMillis(0))
    }

    @Test fun nextFireAcrossDaylightSavingChanges() {
        // 29 Mar 2026 (Sunday): Rome jumps 02:00 → 03:00. A 02:30 reminder fires at 03:30 local that day.
        val r = reminder(ReminderSource.AtacStop("1"), days = setOf(Weekday.SUNDAY), hour = 2, minute = 30)
        val fire = r.nextFireMillis(Fixtures.rome(2026, 3, 28, 12, 0))!!
        assertEquals(Fixtures.rome(2026, 3, 29, 3, 30), fire)
        // 25 Oct 2026: back to winter time; 07:30 is still 07:30 local (UTC+1).
        val autumn = reminder(ReminderSource.AtacStop("1"), days = setOf(Weekday.SUNDAY))
        assertEquals(Fixtures.rome(2026, 10, 25, 7, 30), autumn.nextFireMillis(Fixtures.rome(2026, 10, 24, 12, 0)))
    }

    @Test fun weekdayNumbering() {
        assertEquals(1, Weekday.of(java.time.DayOfWeek.SUNDAY).id)
        assertEquals(2, Weekday.of(java.time.DayOfWeek.MONDAY).id)
        assertEquals(7, Weekday.of(java.time.DayOfWeek.SATURDAY).id)
    }

    // endregion

    // region departure status (port of the backend's departureStatus.ts)

    private fun transit(time: String, delay: Int, monitorata: String = "1", soppressa: String = "N") =
        Transit("i$time", "X", "", time, "", "", soppressa, time, delay, "1", true, "", "", monitorata)

    @Test fun cotralBusStatus() {
        val now = Fixtures.rome(2026, 11, 17, 12, 0)
        val status = ReminderDepartureStatus.fromTransits(
            listOf(transit("11:50", 0), transit("12:20", 0, monitorata = "0"), transit("12:05", 190)),
            now,
        )!!
        assertEquals("12:08", status.time) // 12:05 + 3m10s, delay-adjusted
        assertEquals(3, status.delayMinutes) // truncated, like Math.trunc
        assertFalse(status.isCancelled)
        assertNull(status.nextUsefulTime)

        val early = ReminderDepartureStatus.fromTransits(listOf(transit("12:10", -200)), now)!!
        assertEquals(0, early.delayMinutes) // never negative

        val unmonitored = ReminderDepartureStatus.fromTransits(listOf(transit("12:10", 600, monitorata = "0")), now)!!
        assertNull(unmonitored.delayMinutes)
        assertEquals("12:10", unmonitored.time)

        val cancelled = ReminderDepartureStatus.fromTransits(listOf(transit("12:10", 0, soppressa = "Y"), transit("12:40", 0)), now)!!
        assertTrue(cancelled.isCancelled)
        assertEquals("12:40", cancelled.nextUsefulTime)

        assertNull(ReminderDepartureStatus.fromTransits(listOf(transit("11:00", 0)), now))
    }

    @Test fun cotralBusStatusFromTheRealFixture() {
        val transits = Json.cotralTransits(Fixtures.read("cotral_transits.json")).transits
        val status = ReminderDepartureStatus.fromTransits(transits, Fixtures.rome(2026, 11, 17, 12, 10))!!
        assertEquals("12:16", status.time)
        assertEquals(1, status.delayMinutes)
    }

    @Test fun astralAndAtacStatus() {
        val s = ReminderDepartureStatus.fromAstral(
            listOf(AstralDeparture("1", "12:05", 0, 4, true, false), AstralDeparture("2", "12:20", 0, -2, false, false)),
        )!!
        assertTrue(s.isCancelled)
        assertEquals("12:20", s.nextUsefulTime)
        assertEquals(0, ReminderDepartureStatus.fromAstral(listOf(AstralDeparture("2", "12:20", 0, -2, false, false)))!!.delayMinutes)

        val nowMillis = Fixtures.rome(2026, 11, 17, 12, 0)
        val nowTs = nowMillis / 1000
        fun arrival(dt: Long, delay: Int?, cancelled: Boolean = false) = AtacArrival("t$dt", "64", "64", TransitVehicleKind.BUS, nowTs + dt, delay, null, cancelled)
        val a = ReminderDepartureStatus.fromAtac(listOf(arrival(600, 125), arrival(-60, 0), arrival(300, null, cancelled = true)), nowMillis)!!
        assertEquals("12:05", a.time)
        assertTrue(a.isCancelled)
        assertEquals("12:10", a.nextUsefulTime)
        assertNull(a.delayMinutes)
        assertEquals(2, ReminderDepartureStatus.fromAtac(listOf(arrival(600, 125)), nowMillis)!!.delayMinutes)
        assertNull(ReminderDepartureStatus.fromAtac(emptyList(), nowMillis))
    }

    // endregion

    // region notification texts (identical to the backend's notifier.ts)

    @Test fun notificationTexts() {
        val bus = reminder(ReminderSource.CotralBus("f3583"), name = "Anagnina Metro A")
        ReminderTexts.content(bus, ReminderDepartureStatus("12:16", 1, false, null)).let {
            assertEquals("Prossimo bus alle 12:16", it.title)
            assertEquals("Il prossimo bus per Anagnina Metro A è in ritardo di 1 minuto.", it.body)
        }
        assertEquals(
            "Il prossimo bus per Anagnina Metro A è in ritardo di 7 minuti.",
            ReminderTexts.content(bus, ReminderDepartureStatus("12:16", 7, false, null)).body,
        )
        assertEquals(
            "Il prossimo bus per Anagnina Metro A non fa ritardo.",
            ReminderTexts.content(bus, ReminderDepartureStatus("12:16", null, false, null)).body,
        )
        val train = reminder(ReminderSource.CotralTrain("Acilia", CotralTrainRoute.METROMARE_PSP_TO_COLOMBO, "RL_ACILIA"))
        ReminderTexts.content(train, ReminderDepartureStatus("07:41", 0, true, "07:56")).let {
            assertEquals("Prossimo treno alle 07:41", it.title)
            assertEquals("Il prossimo treno per Acilia, direzione Porta San Paolo → Cristoforo Colombo è stato soppresso. Prossimo utile: 07:56.", it.body)
        }
        assertEquals(
            "Il prossimo treno per Acilia, direzione Porta San Paolo → Cristoforo Colombo è stato soppresso. Nessun'altra corsa in programma.",
            ReminderTexts.content(train, ReminderDepartureStatus("07:41", 0, true, null)).body,
        )
    }

    // endregion

    // region scheduling rules

    @Test fun planUsesThePendingRetryOrTheNextOccurrence() {
        val r = reminder(ReminderSource.AtacStop("1"))
        val now = Fixtures.rome(2026, 11, 17, 7, 33)
        val occurrence = Fixtures.rome(2026, 11, 17, 7, 30)
        val retry = ReminderScheduler.RetryState(occurrence, 2, now + 60_000)
        ReminderScheduler.plan(r, retry, now)!!.let {
            assertEquals(now + 60_000, it.atMillis)
            assertEquals(occurrence, it.occurrenceMillis)
            assertEquals(2, it.retry?.attempt)
        }
        // A retry whose time is long gone (phone off) is dropped: next occurrence, no retroactive run.
        ReminderScheduler.plan(r, retry, now + 3_600_000)!!.let {
            assertEquals(Fixtures.rome(2026, 11, 18, 7, 30), it.atMillis)
            assertNull(it.retry)
        }
        ReminderScheduler.plan(r, null, now)!!.let { assertEquals(Fixtures.rome(2026, 11, 18, 7, 30), it.atMillis) }
    }

    @Test fun retriesEveryTwoMinutesAtMost15TimesWithinAnHour() {
        val occurrence = 1_000_000_000_000L
        var attempt = 0
        var now = occurrence
        var retries = 0
        while (true) {
            val next = ReminderScheduler.nextRetry(occurrence, attempt, now) ?: break
            assertEquals(now + Config.REMINDER_RETRY_INTERVAL_MS, next.retryAtMillis)
            attempt = next.attempt
            now = next.retryAtMillis
            retries++
        }
        assertEquals(14, retries) // 1 first try + 14 retries = 15 checks, as on iOS
        // A chain that would pass the 60-minute mark stops early.
        assertNull(ReminderScheduler.nextRetry(occurrence, 1, occurrence + Config.REMINDER_CHAIN_MAX_AGE_MS))
        assertNotNull(ReminderScheduler.nextRetry(occurrence, 0, occurrence))
    }

    @Test fun retryStateRoundTrips() {
        val s = ReminderScheduler.RetryState(1L, 3, 2L)
        assertEquals(s, ReminderScheduler.RetryState.fromJson(s.toJson()))
        assertNull(ReminderScheduler.RetryState.fromJson("{oops"))
    }

    // endregion

    // region status fetcher against a stubbed backend

    private fun withServer(vararg bodies: Pair<Int, String>, block: suspend (ReminderStatusFetcher, MockWebServer) -> Unit) {
        val server = MockWebServer()
        bodies.forEach { (code, body) -> server.enqueue(MockResponse().setResponseCode(code).setBody(body)) }
        server.start()
        try {
            val api = MadovaiApi(ApiClient(server.url("/api/v1").toString(), server.url("/health").toString(), MadovaiApi.httpClient(2), "test"))
            runBlocking { block(ReminderStatusFetcher(api), server) }
        } finally {
            server.shutdown()
        }
    }

    @Test fun fetcherCotralBus() = withServer(200 to Fixtures.read("cotral_transits.json")) { fetcher, server ->
        val status = fetcher.status(reminder(ReminderSource.CotralBus("f3583")), Fixtures.rome(2026, 11, 17, 12, 10))
        assertEquals("12:16", status?.time)
        assertEquals("/api/v1/cotral-transits?pole=f3583", server.takeRequest().path)
    }

    @Test fun fetcherTrainUsesRailAndPicksTheDirectionByRoute() = withServer(200 to Fixtures.read("rail.json")) { fetcher, server ->
        val r = reminder(ReminderSource.CotralTrain("Acilia", CotralTrainRoute.METROMARE_PSP_TO_COLOMBO, "RL_ACILIA"))
        val status = fetcher.status(r, Fixtures.rome(2026, 11, 17, 5, 40))!!
        assertEquals("05:51", status.time) // first RL_PSP-CC entry after 05:40 (05:36 has passed)
        assertEquals("/api/v1/rail?stop=RL_ACILIA", server.takeRequest().path)
    }

    @Test fun fetcherTrainWithoutStationIdFallsBackToAstralLine() = withServer(200 to Fixtures.read("astral_line.json")) { fetcher, server ->
        val r = reminder(ReminderSource.CotralTrain("porta san paolo", CotralTrainRoute.METROMARE_PSP_TO_COLOMBO, null))
        val status = fetcher.status(r, Fixtures.rome(2026, 11, 17, 12, 0))!!
        assertEquals("12:45", status.time)
        assertEquals("/api/v1/astral-line?route=RL_PSP-CC", server.takeRequest().path)
    }

    @Test fun fetcherAtac() = withServer(200 to Fixtures.read("atac_live.json")) { fetcher, _ ->
        val live = Json.atacLive(Fixtures.read("atac_live.json")).getValue("83124").first()
        val status = fetcher.status(reminder(ReminderSource.AtacStop("83124")), (live.ts - 300) * 1000)!!
        assertEquals(live.timeLabel, status.time)
    }

    @Test fun fetcherFailuresThrowSoTheSchedulerRetries() = withServer(503 to """{"error":"Dati non pronti"}""") { fetcher, _ ->
        try {
            fetcher.status(reminder(ReminderSource.AtacStop("1")))
            fail("expected an error")
        } catch (e: ApiException) {
            assertEquals(ApiException.Kind.NOT_READY, e.kind)
        }
    }

    @Test fun directionMatchingFallsBackToDestinationName() {
        val dirs = Json.rail(Fixtures.read("rail.json")).directions.map { it.copy(route = null) }
        assertEquals("Cristoforo Colombo", ReminderStatusFetcher.direction(CotralTrainRoute.METROMARE_PSP_TO_COLOMBO, dirs)?.destination)
        assertTrue(ReminderStatusFetcher.sameName(" Città ", "citta"))
    }

    // endregion
}
