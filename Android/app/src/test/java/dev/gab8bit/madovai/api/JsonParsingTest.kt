package dev.gab8bit.madovai.api

import dev.gab8bit.madovai.Fixtures
import dev.gab8bit.madovai.model.TransitOperator
import dev.gab8bit.madovai.model.TransitTrackingStatus
import dev.gab8bit.madovai.model.TransitVehicleKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Decoding of every endpoint, against JSON captured from the production backend. */
class JsonParsingTest {

    @Test fun health() {
        val h = Json.health(Fixtures.read("health.json"))
        assertTrue(h.ok)
        assertTrue(h.gtfsReady)
    }

    @Test fun stopsInBox() {
        val s = Json.stops(Fixtures.read("stops.json"))
        assertEquals(2, s.poles.size)
        val pole = s.poles.first()
        assertEquals("f3583", pole.code)
        assertEquals("f3583", pole.codicePalina)
        assertEquals("ROMA", pole.localita)
        assertFalse(pole.isTreno)
        assertNotNull(pole.coordinate)
        assertEquals(40, s.atacStops.size)
        assertEquals("83124", s.atacStops.first().stopId)
        assertEquals("ANAGNINA METRO A", s.atacStops.first().stopName)
    }

    @Test fun search() {
        val r = Json.search(Fixtures.read("search.json"))
        assertTrue(r.stops.isNotEmpty())
        val metro = r.stops.first { it.stopId == "AD27" }
        assertEquals("atac", metro.source)
        assertTrue(metro.metro)
        val bus = r.stops.first { it.stopId == "05019" }
        assertFalse(bus.metro)
        assertEquals("Atac / Roma TPL", bus.subtitle)
    }

    @Test fun linesCatalog() {
        val l = Json.lines(Fixtures.read("lines.json"))
        assertEquals(3, l.cotralRail.size)
        assertTrue(l.atac.size > 400)
        val lido = l.cotralRail.first { it.routeId == "F:ROMALIDO" }
        assertTrue(lido.rail)
        assertEquals(TransitVehicleKind.TRENO, lido.kind)
        assertEquals("METROMARE", lido.title)
        assertEquals("Cotral · treno", lido.operatorLabel)
        val metroA = l.atac.first { it.routeId == "MEA" }
        assertEquals("Metro A", metroA.title)
        assertEquals(TransitVehicleKind.METRO, metroA.kind)
        val bus = l.atac.first { it.routeId == "211" }
        assertEquals("211", bus.title)
        assertNull(bus.colorHex)
    }

    @Test fun atacLineKeepsRouteOrder() {
        val d = Json.line(Fixtures.read("line_atac.json"))
        assertEquals("211", d.route.routeId)
        assertEquals(53, d.stops.size)
        // Backend order is route order: the first stop is the terminus, not the alphabetically first name.
        assertEquals("82006", d.stops.first().id)
        assertEquals("Cimone/Monte Acero", d.stops.first().headsign)
        assertEquals(4, d.shapes.size)
        assertTrue(d.shapes.all { it.routeId == "211" && it.kind == TransitVehicleKind.BUS && it.points.size > 10 })
        d.shapes.flatMap { it.points }.forEach {
            assertTrue(it.latitude in 41.7..42.1)
            assertTrue(it.longitude in 12.3..12.8)
        }
    }

    @Test fun cotralRailLine() {
        val d = Json.line(Fixtures.read("line_rail.json"))
        assertTrue(d.route.isCotral)
        assertEquals(14, d.stops.size)
        assertEquals(2, d.shapes.size)
        assertTrue(d.shapes.all { it.kind == TransitVehicleKind.TRENO })
    }

    @Test fun viewportShapes() {
        val shapes = Json.shapes(Fixtures.read("shapes.json"))
        assertTrue(shapes.isNotEmpty())
        assertTrue(shapes.all { it.routeId.isNotEmpty() && it.points.size >= 2 })
    }

    @Test fun railPoleAndSchedule() {
        val p = Json.pole(Fixtures.read("pole_rail.json"))
        assertEquals("RL_ACILIA", p.id)
        assertTrue(p.rail)
        assertEquals(listOf("RL_CC-PSP", "RL_PSP-CC"), p.trainRoutes)

        val r = Json.rail(Fixtures.read("rail.json"))
        assertEquals("astral", r.source)
        assertEquals(2, r.directions.size)
        val toColombo = r.directions.first { it.route == "RL_PSP-CC" }
        assertEquals("Cristoforo Colombo", toColombo.destination)
        assertEquals(70, toColombo.entries.size)
        assertEquals("RL53", toColombo.entries.first().id)
        assertEquals(0, toColombo.entries.first().delayMinutes)
        assertTrue(toColombo.entries.zipWithNext().all { (a, b) -> a.sortSeconds <= b.sortSeconds })
    }

    @Test fun astralLine() {
        val a = Json.astralLine(Fixtures.read("astral_line.json"))
        assertEquals("RL_PSP-CC", a.route)
        assertEquals("Metromare", a.lineName)
        assertEquals("Porta San Paolo", a.stations.first().name)
        assertEquals("12:45", a.stations.first().next?.time)
    }

    @Test fun cotralTransits() {
        val t = Json.cotralTransits(Fixtures.read("cotral_transits.json"))
        assertEquals("Roma", t.pole?.comune)
        assertEquals(133, t.transits.size)
        val first = t.transits.first()
        assertEquals("FR766D", first.percorso)
        assertEquals(70, first.ritardoSeconds)
        assertEquals("6736", first.vehicleCode)
        assertTrue(first.vehicleAlive)
        assertEquals(TransitTrackingStatus.REALTIME, first.trackingStatus)
        assertTrue(first.canTrackVehicle)
        assertEquals("12:16", first.adjustedDisplayTime)
        // "n.d." vehicles on unmonitored runs can't be followed.
        val nd = t.transits.first { it.vehicleCode == "n.d." }
        assertFalse(nd.canTrackVehicle)
        assertEquals(TransitTrackingStatus.SCHEDULED, nd.trackingStatus)
    }

    @Test fun cotralVehicles() {
        val v = Json.cotralVehicles(Fixtures.read("cotral_vehicles.json"))
        assertEquals(3, v.size)
        assertEquals("cotral-6736", v.first().id)
        assertEquals("6736", v.first().vehicleCode)
        assertEquals(70, v.first().delaySeconds)
        assertEquals(TransitOperator.COTRAL, v.first().transitOperator)
        assertNotNull(Json.cotralVehicle(Fixtures.read("cotral_vehicle.json")))
        assertNull(Json.cotralVehicle("""{"lat":null,"lon":null}"""))
        assertNull(Json.cotralVehicle("""{"lat":0,"lon":0}"""))
    }

    @Test fun atacFleet() {
        val f = Json.atacVehicles(Fixtures.read("atac_vehicles.json"))
        assertEquals(40, f.vehicles.size)
        val v = f.vehicles.first()
        assertEquals("atac-52", v.id)
        assertEquals("105", v.routeId)
        assertEquals("0#583-7", v.tripId)
        assertEquals("Parco Di Centocelle", v.headsign)
        assertNull(v.bearing)
        assertEquals(TransitOperator.ATAC, v.transitOperator)
        assertEquals("105", v.lineLabel)
    }

    @Test fun atacLiveStopAndSchedule() {
        val live = Json.atacLive(Fixtures.read("atac_live.json"))
        assertEquals(setOf("83124", "82543", "05019"), live.keys)
        assertTrue(live.getValue("05019").isEmpty())
        val a = live.values.flatten().first()
        assertTrue(a.ts > 1_700_000_000L)
        assertFalse(a.cancelled)

        val platforms = Json.atacStop(Fixtures.read("atac_stop.json"))
        assertEquals(11, platforms.size)
        assertEquals("Anagnina", platforms.first().headsign)

        val schedule = Json.atacSchedule(Fixtures.read("atac_schedule.json"))
        assertTrue(schedule.isNotEmpty())
        assertTrue(schedule.all { it.delaySeconds == null && !it.cancelled })
    }

    @Test fun atacTrip() {
        val t = Json.atacTrip(Fixtures.read("atac_trip.json"))
        assertEquals("0#583-7", t.tripId)
        assertEquals("Parco Di Centocelle", t.headsign)
        assertTrue(t.stops.isNotEmpty())
        assertEquals(-270, t.stops.first().delaySeconds)
        assertTrue(t.stops.zipWithNext().all { (a, b) -> a.sequence <= b.sequence })
    }

    @Test fun tolerantDecoding() {
        // JSON null strings must not become the text "null"; garbage elements are skipped.
        val r = Json.search("""{"stops":[{"source":"atac","id":"1","name":null,"lat":41.9,"lon":12.5},{"id":null},7],"routes":[{"id":"X","shortName":"X","longName":null,"displayName":null,"kind":"weird","operator":null,"color":"","rail":null}]}""")
        assertEquals(1, r.stops.size)
        assertEquals("1", r.stops.first().name)
        val route = r.routes.single()
        assertEquals("", route.longName)
        assertEquals("X", route.displayName)
        assertEquals(TransitVehicleKind.BUS, route.kind)
        assertNull(route.colorHex)
    }
}
