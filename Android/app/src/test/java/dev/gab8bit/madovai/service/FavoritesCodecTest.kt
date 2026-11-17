package dev.gab8bit.madovai.service

import dev.gab8bit.madovai.Fixtures
import dev.gab8bit.madovai.api.Json
import dev.gab8bit.madovai.model.AtacStop
import dev.gab8bit.madovai.model.FavoriteStop
import dev.gab8bit.madovai.model.Pole
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Favorites saved by 1.0.0 must survive the update to 2.0.0 unchanged: same storage JSON,
 * and the ids inside it are the ones the backend expects.
 */
class FavoritesCodecTest {
    /** Exactly what 1.0.0's FavoritesStore.encode() wrote (bus pole, rail station, Atac platform). */
    private val v1Json = """[
        {"type":"cotral","pole":{"codicePalina":"f3583","codiceStop":"f3583","nomePalina":"ROMA | Anagnina (Metro A)","nomeStop":"ROMA | Anagnina (Metro A)","localita":"ROMA","coordX":41.8432898071,"coordY":12.5855531083,"destinazioni":["FROSINONE"],"isCotral":1,"isTreno":false}},
        {"type":"cotral","pole":{"codicePalina":"RL_ACILIA","codiceStop":"RL_ACILIA","nomePalina":"Acilia","nomeStop":"Acilia","localita":"Acilia","coordX":41.7832974,"coordY":12.36061706,"isTreno":true}},
        {"type":"atac","stop":{"stopId":"05019","stopName":"ANAGNINA (MA)","lat":41.84297,"lon":12.584973}},
        {"type":"atac","stop":{"stopId":"05019","stopName":"duplicate","lat":0,"lon":0}},
        {"type":"mystery"}
    ]"""

    @Test fun decodes1_0_0Favorites() {
        val items = FavoritesCodec.decode(v1Json)
        assertEquals(listOf("cotral:f3583", "cotral:RL_ACILIA", "atac:05019"), items.map { it.id })
        val bus = (items[0] as FavoriteStop.Cotral).pole
        assertEquals("f3583", bus.code)
        assertEquals("ROMA | Anagnina (Metro A)", bus.displayName)
        assertEquals(false, bus.isTreno)
        assertTrue((items[1] as FavoriteStop.Cotral).pole.isTreno)
        assertEquals("ANAGNINA (MA)", (items[2] as FavoriteStop.Atac).stop.stopName)
    }

    @Test fun v1IdsAreTheBackendIds() {
        // The same stops as the backend returns them today: identical ids, so no migration is needed.
        val fromBackend = Json.stops(Fixtures.read("stops.json")).poles.map { "cotral:${it.code}" } +
            Json.search(Fixtures.read("search.json")).stops.filter { !it.isCotral }.map { "atac:${it.stopId}" } +
            "cotral:${Json.pole(Fixtures.read("pole_rail.json")).id}"
        FavoritesCodec.decode(v1Json).forEach { assertTrue(it.id, it.id in fromBackend) }
    }

    @Test fun roundTripKeepsTheFormat() {
        val items = listOf(
            FavoriteStop.Cotral(Pole.fromStop("f3583", "ROMA | Anagnina (Metro A)", "ROMA", 41.84, 12.58, false)),
            FavoriteStop.Atac(AtacStop("05019", "ANAGNINA (MA)", 41.84, 12.58)),
        )
        val json = FavoritesCodec.encode(items)
        assertTrue(json.contains("\"codicePalina\":\"f3583\""))
        assertTrue(json.contains("\"stopId\":\"05019\""))
        assertEquals(items, FavoritesCodec.decode(json))
    }

    @Test fun garbageIsEmptyNotACrash() {
        assertTrue(FavoritesCodec.decode("{not json").isEmpty())
        assertTrue(FavoritesCodec.decode(null).isEmpty())
    }
}
