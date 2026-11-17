package dev.gab8bit.madovai.api

import dev.gab8bit.madovai.Fixtures
import dev.gab8bit.madovai.model.ViewportBounds
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

/** The HTTP client against a local MockWebServer: URLs, Italian error mapping, transport failures. */
class ApiClientTest {
    private lateinit var server: MockWebServer
    private lateinit var api: MadovaiApi

    @Before fun setUp() {
        server = MockWebServer()
        server.start()
        val client = ApiClient(server.url("/api/v1").toString(), server.url("/health").toString(), MadovaiApi.httpClient(2), "Madovai-Android/test")
        api = MadovaiApi(client)
    }

    @After fun tearDown() {
        server.shutdown()
    }

    private fun json(body: String, code: Int = 200) = MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body)

    private inline fun expectApiError(kind: ApiException.Kind, block: () -> Unit): ApiException {
        try {
            block()
        } catch (e: ApiException) {
            assertEquals(kind, e.kind)
            return e
        }
        fail("expected ApiException $kind")
        throw IllegalStateException()
    }

    @Test fun buildsVersionedUrlsAndEncodesTripIds() = runBlocking {
        server.enqueue(json(Fixtures.read("atac_trip.json")))
        api.atacTrip("0#583-7")
        val request = server.takeRequest()
        assertEquals("/api/v1/atac-trip?trip=0%23583-7", request.path)
        assertEquals("application/json", request.getHeader("Accept"))
        assertEquals("Madovai-Android/test", request.getHeader("User-Agent"))
    }

    @Test fun bboxQueryUsesDotDecimals() = runBlocking {
        server.enqueue(json(Fixtures.read("stops.json")))
        api.stops(ViewportBounds(41.835, 41.85, 12.575, 12.595))
        val path = server.takeRequest().path!!
        assertTrue(path, path.startsWith("/api/v1/stops?"))
        assertTrue(path, path.contains("minLat=41.83500") && path.contains("maxLon=12.59500"))
        assertTrue(path, path.contains("cotralLimit=120") && path.contains("atacLimit=400"))
    }

    @Test fun healthIsAtServerRoot() = runBlocking {
        server.enqueue(json(Fixtures.read("health.json")))
        assertTrue(api.health().gtfsReady)
        assertEquals("/health", server.takeRequest().path)
    }

    @Test fun backendErrorMessageIsPassedThrough() = runBlocking {
        server.enqueue(json(Fixtures.read("err400.json"), 400))
        val e = expectApiError(ApiException.Kind.BAD_REQUEST) { api.line("atac", "NOPE_XYZ") }
        assertEquals("Linea inesistente", e.message)
        assertEquals(400, e.status)
    }

    @Test fun notReadyRateLimitedAndUpstream() = runBlocking {
        server.enqueue(json("""{"error":"Dati statici non ancora pronti"}""", 503))
        assertEquals("Dati statici non ancora pronti", expectApiError(ApiException.Kind.NOT_READY) { api.lines() }.message)
        server.enqueue(json("""{"error":"Troppe richieste, riprova tra poco"}""", 429))
        expectApiError(ApiException.Kind.RATE_LIMITED) { api.lines() }
        // A proxy's HTML error page: no JSON, generic Italian text.
        server.enqueue(MockResponse().setResponseCode(502).setBody("<html>Bad gateway</html>"))
        val e = expectApiError(ApiException.Kind.SERVER) { api.lines() }
        assertEquals("La fonte dei dati non risponde. Riprova tra qualche secondo.", e.message)
        assertTrue(e.isTransient)
    }

    @Test fun malformedJsonIsADecodingError() = runBlocking {
        server.enqueue(json("{not json"))
        expectApiError(ApiException.Kind.DECODING) { api.lines() }
        Unit
    }

    @Test fun noConnectionIsOffline() = runBlocking {
        // Nothing listens on port 1: connection refused.
        val unreachable = MadovaiApi(ApiClient("http://127.0.0.1:1/api/v1", "http://127.0.0.1:1/health", MadovaiApi.httpClient(2), "test"))
        val e = expectApiError(ApiException.Kind.OFFLINE) { unreachable.lines() }
        assertEquals("Connessione assente o server non raggiungibile.", e.message)
    }

    @Test fun slowServerIsATimeout() = runBlocking {
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
        expectApiError(ApiException.Kind.TIMEOUT) { api.lines() }
        Unit
    }

    @Test fun atacLiveIsChunkedAt150Stops() = runBlocking {
        server.enqueue(json("""{"updated":1,"stops":{"1":[]}}"""))
        server.enqueue(json("""{"updated":1,"stops":{"151":[]}}"""))
        val ids = (1..160).map { it.toString() }
        val result = api.atacLive(ids + ids)
        assertEquals(setOf("1", "151"), result.keys)
        val counts = listOf(server.takeRequest(), server.takeRequest()).map { it.requestUrl!!.queryParameter("stops")!!.split(",").size }.sorted()
        assertEquals(listOf(10, 150), counts)
    }

    @Test fun cotralVehiclesSendsAtMost15Poles() = runBlocking {
        server.enqueue(json(Fixtures.read("cotral_vehicles.json")))
        api.cotralVehicles((1..30).map { "p$it" })
        assertEquals(15, server.takeRequest().requestUrl!!.queryParameter("poles")!!.split(",").size)
    }

    @Test fun emptyQueriesDoNotHitTheServer() = runBlocking {
        assertTrue(api.search("   ").stops.isEmpty())
        assertTrue(api.atacLive(emptyList()).isEmpty())
        assertTrue(api.cotralVehicles(emptyList()).isEmpty())
        assertEquals(0, server.requestCount)
    }
}
