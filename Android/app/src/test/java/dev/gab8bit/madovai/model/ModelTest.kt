package dev.gab8bit.madovai.model

import dev.gab8bit.madovai.Fixtures
import dev.gab8bit.madovai.live.CotralViewportVehicleService
import dev.gab8bit.madovai.ui.LineFocus
import dev.gab8bit.madovai.ui.MapViewModel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ModelTest {
    private val noon = Fixtures.rome(2026, 11, 17, 12, 0)

    private fun transit(time: String, delay: Int = 0, monitorata: String = "1", alive: Boolean = true, soppressa: String = "N", code: String? = "123") =
        Transit("id$time$delay", "AB12", "A", time, "ROMA | Termini (f1)", "13:00", soppressa, time, delay, code, alive, "", "", monitorata)

    @Test fun polylineDecodesGoogleReferenceVector() {
        // Example from Google's Encoded Polyline Algorithm documentation.
        val pts = Polyline.decode("_p~iF~ps|U_ulLnnqC_mqNvxq`@")
        assertEquals(3, pts.size)
        assertEquals(38.5, pts[0].latitude, 1e-9)
        assertEquals(-120.2, pts[0].longitude, 1e-9)
        assertEquals(43.252, pts[2].latitude, 1e-9)
        assertEquals(-126.453, pts[2].longitude, 1e-9)
    }

    @Test fun minutesFromNowWrapsAroundMidnight() {
        val lateEvening = Fixtures.rome(2026, 11, 17, 23, 50)
        assertEquals(20, RomeTime.minutesFromNow("00:10", lateEvening))
        assertEquals(-20, RomeTime.minutesFromNow("23:30", lateEvening))
        val earlyMorning = Fixtures.rome(2026, 11, 18, 0, 5)
        assertEquals(-15, RomeTime.minutesFromNow("23:50", earlyMorning))
        assertEquals(25, RomeTime.minutesFromNow("24:30", earlyMorning))
        assertNull(RomeTime.minutesFromNow("--:--", earlyMorning))
    }

    @Test fun reliableDelayShiftsTheTimeAndUnreliableDoesNot() {
        assertEquals("12:16", transit("12:15", delay = 70).adjustedDisplayTime)
        assertEquals("12:15", transit("12:15", delay = 50).adjustedDisplayTime) // under a minute
        assertEquals("12:15", transit("12:15", delay = 300, alive = false).adjustedDisplayTime) // monitored offline
        assertEquals("12:15", transit("12:15", delay = 300, monitorata = "0").adjustedDisplayTime) // scheduled
        assertEquals("00:02", transit("23:58", delay = 240).adjustedDisplayTime) // wraps past midnight
        assertEquals("12:10", transit("12:15", delay = -300).adjustedDisplayTime) // early
    }

    @Test fun sheetDropsStaleRunsButKeepsLateOnes() {
        val list = listOf(
            transit("12:20"),
            transit("11:50"), // 10 min ago: stale
            transit("11:55", delay = 360), // timetable passed, but really arrives at 12:01
            transit("11:59"), // 1 min ago: kept ("in transito")
        )
        val shown = Transit.upcomingForSheet(list, noon)
        assertEquals(listOf("11:59", "12:01", "12:20"), shown.map { it.adjustedDisplayTime })
    }

    @Test fun trackingStatusAndFollowability() {
        assertEquals(TransitTrackingStatus.REALTIME, transit("12:00").trackingStatus)
        assertEquals(TransitTrackingStatus.MONITORED_OFFLINE, transit("12:00", alive = false).trackingStatus)
        assertEquals(TransitTrackingStatus.SCHEDULED, transit("12:00", monitorata = "0").trackingStatus)
        assertTrue(transit("12:00", soppressa = " y ").isCancelled)
        assertEquals(false, transit("12:00", code = null).canTrackVehicle)
    }

    @Test fun upcomingAstralEntriesUseRomeTime() {
        val entries = listOf(
            AstralDeparture("a", "11:30", 11 * 3600 + 1800, 0, false, false),
            AstralDeparture("c", "12:30", 12 * 3600 + 1800, null, false, false),
            AstralDeparture("b", "12:05", 12 * 3600 + 300, 2, false, false),
        )
        assertEquals(listOf("b", "c"), entries.upcoming(noon).map { it.id })
    }

    @Test fun railDirectionsWithTheSameDestinationAreMerged() {
        val a = AstralScheduleDirection("Catalano", "RV_VITCAT", listOf(AstralDeparture("1", "10:00", 36000, 0, false, false)))
        val b = AstralScheduleDirection("Catalano", "RV_MORCAT", listOf(AstralDeparture("2", "09:00", 32400, 0, false, false)))
        val c = AstralScheduleDirection("Viterbo", "RV_CATVIT", emptyList())
        val merged = RailSchedule.mergeSameDestination(listOf(c, a, b))
        assertEquals(listOf("Catalano", "Viterbo"), merged.map { it.destination })
        assertEquals(listOf("2", "1"), merged[0].entries.map { it.id })
    }

    @Test fun routeTitles() {
        fun route(source: String, id: String, short: String, long: String, display: String, kind: TransitVehicleKind, rail: Boolean = false) =
            RouteInfo(source, id, short, long, display, kind, TransitOperator.ATAC, null, rail)
        assertEquals("64", route("atac", "64", "64", "Termini - San Pietro", "Termini - San Pietro", TransitVehicleKind.BUS).title)
        assertEquals("Metro B1", route("atac", "MEB1", "MEB1", "", "Metro B1", TransitVehicleKind.METRO).title)
        assertEquals("METROMARE", route("cotral", "F:ROMALIDO", "ROMALIDO", "METROMARE", "ROMALIDO", TransitVehicleKind.TRENO, rail = true).title)
        assertEquals("CF952A", route("cotral", "CF952A", "CF952A", "Velletri - Roma", "CF952A", TransitVehicleKind.BUS).title)
        assertNull(route("atac", "211", "211", "", "211", TransitVehicleKind.BUS).subtitleName)
    }

    @Test fun platformsAreGroupedNotDeduplicated() {
        val groups = groupedStopsByName(
            listOf(AtacStop("2", "TERMINI", 0.0, 0.0), AtacStop("9", "REPUBBLICA", 0.0, 0.0), AtacStop("1", "TERMINI ", 0.0, 0.0)),
        )
        assertEquals(listOf("TERMINI", "REPUBBLICA"), groups.map { it.name })
        assertEquals(listOf("1", "2"), groups[0].stops.map { it.stopId })
        assertEquals("1", groups[0].anchor.stopId)
    }

    @Test fun cotralVehiclesSurviveOneMissedScan() {
        fun v(id: String) = TransitVehicle(id, LatLon(41.9, 12.5), null, "R", "R", TransitVehicleKind.BUS, TransitOperator.COTRAL, null, null, null, id)
        var state = CotralViewportVehicleService.merge(emptyMap(), emptyMap(), listOf(v("a"), v("b")), 2)
        state = CotralViewportVehicleService.merge(state.first, state.second, listOf(v("a")), 2)
        assertEquals(setOf("a", "b"), state.first.keys)
        state = CotralViewportVehicleService.merge(state.first, state.second, listOf(v("a")), 2)
        assertEquals(setOf("a", "b"), state.first.keys)
        state = CotralViewportVehicleService.merge(state.first, state.second, listOf(v("a")), 2)
        assertEquals(setOf("a"), state.first.keys)
    }

    @Test fun vehiclesAreHiddenWhenZoomedOutUnlessTheirLineIsFocused() {
        fun v(id: String, lat: Double, route: String) = TransitVehicle(id, LatLon(lat, 12.5), null, route, route, TransitVehicleKind.BUS, TransitOperator.ATAC, null, null, null, null)
        val all = listOf(v("in", 41.90, "64"), v("far", 42.50, "64"), v("other", 41.90, "40"))
        val bounds = ViewportBounds(41.88, 41.92, 12.48, 12.52)
        assertEquals(listOf("in", "other"), MapViewModel.visibleVehicles(all, null, MapViewport(bounds, 15.0)).map { it.id })
        assertTrue(MapViewModel.visibleVehicles(all, null, MapViewport(bounds, 10.0)).isEmpty())
        assertEquals(listOf("in", "far"), MapViewModel.visibleVehicles(all, "64", MapViewport(bounds, 9.0)).map { it.id })
    }

    @Test fun focusedAtacLineShowsOnlyItsStations() {
        val focus = LineFocus("64", LineFocus.Kind.ATAC, stops = listOf(AtacStop("1", "A", 0.0, 0.0), AtacStop("2", "A", 0.0, 0.0), AtacStop("3", "B", 0.0, 0.0)))
        assertEquals(listOf("1", "3"), MapViewModel.shownAtacStops(focus, listOf(AtacStop("9", "Z", 0.0, 0.0))).map { it.stopId })
        assertTrue(MapViewModel.shownAtacStops(LineFocus("RL_PSP-CC", LineFocus.Kind.COTRAL), emptyList()).isEmpty())
        assertEquals("Metromare · Porta San Paolo → Cristoforo Colombo", LineFocus("RL_PSP-CC", LineFocus.Kind.COTRAL).title)
    }
}
