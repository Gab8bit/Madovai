package dev.gab8bit.madovai.ui

import androidx.compose.runtime.mutableStateListOf
import dev.gab8bit.madovai.Config
import dev.gab8bit.madovai.api.ApiException
import dev.gab8bit.madovai.api.MadovaiApi
import dev.gab8bit.madovai.api.userMessage
import dev.gab8bit.madovai.live.ConnectivityMonitor
import dev.gab8bit.madovai.live.CotralViewportVehicleService
import dev.gab8bit.madovai.live.LinesStore
import dev.gab8bit.madovai.model.AtacStop
import dev.gab8bit.madovai.model.AtacStopGroup
import dev.gab8bit.madovai.model.CotralTrainRoute
import dev.gab8bit.madovai.model.LatLon
import dev.gab8bit.madovai.model.MapShape
import dev.gab8bit.madovai.model.MapViewport
import dev.gab8bit.madovai.model.Pole
import dev.gab8bit.madovai.model.RouteInfo
import dev.gab8bit.madovai.model.SearchResults
import dev.gab8bit.madovai.model.SearchStop
import dev.gab8bit.madovai.model.TransitVehicle
import dev.gab8bit.madovai.model.ViewportBounds
import dev.gab8bit.madovai.model.groupedStopsByName
import dev.gab8bit.madovai.service.LocationTracker
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/** A one-shot request for the map camera; `nonce` lets the same target be requested twice. */
sealed interface CameraRequest {
    val nonce: Long

    data class Center(val center: LatLon, val zoom: Double, override val nonce: Long = System.nanoTime()) : CameraRequest
    /** Fit all points, not zooming in past [maxZoom]. */
    data class Fit(val points: List<LatLon>, val maxZoom: Double, override val nonce: Long = System.nanoTime()) : CameraRequest
}

/**
 * The line isolated on the map (its shape, stops and vehicles only), set by tapping a
 * vehicle or picking an Atac line in search. It stays until "Reset" — closing a sheet
 * doesn't clear it.
 */
data class LineFocus(
    /** Atac route id, or a Cotral `percorso` (ASTRAL code for a train) — compared with TransitVehicle.routeId. */
    val routeId: String,
    val kind: Kind,
    val route: RouteInfo? = null,
    val stops: List<AtacStop> = emptyList(),
    val shapes: List<MapShape> = emptyList(),
) {
    enum class Kind { LOADING, ATAC, COTRAL, UNKNOWN }

    /** Second line of the "Mostro solo questa linea" banner. */
    val title: String?
        get() {
            CotralTrainRoute.fromRaw(routeId)?.let { return "${it.lineName} · ${it.directionLabel}" }
            route?.let { return if (it.isMetro || it.rail) it.title else "Linea ${it.title}" }
            return if (kind == Kind.LOADING) null else "Linea $routeId"
        }
}

/** Every bottom sheet the app can show. Kept in a stack so a sheet can open another one. */
sealed interface SheetRoute {
    val key: String

    data class CotralPole(val pole: Pole) : SheetRoute { override val key get() = "pole:${pole.id}" }
    data class AtacStation(val group: AtacStopGroup, val routeId: String?) : SheetRoute { override val key get() = "atac:${group.id}:$routeId" }
    data class Vehicle(val vehicle: TransitVehicle) : SheetRoute { override val key get() = "vehicle:${vehicle.id}" }
    /** A line picked from the map's search (Cotral) — there's no navigation stack on the map to push onto. */
    data class Line(val route: RouteInfo) : SheetRoute { override val key get() = "line:${route.id}" }
    data object Info : SheetRoute { override val key get() = "info" }
}

class SheetHostState {
    val stack = mutableStateListOf<SheetRoute>()
    val top: SheetRoute? get() = stack.lastOrNull()

    fun push(route: SheetRoute) {
        if (stack.lastOrNull()?.key == route.key) return
        stack.add(route)
    }

    fun pop() {
        if (stack.isNotEmpty()) stack.removeAt(stack.lastIndex)
    }

    fun clear() = stack.clear()
}

/**
 * Map-screen state: stops/poles and line shapes for the settled viewport (from the backend,
 * only from zoom 13), the focused line, the search and the banners' loading/error state.
 * Process-scoped (lives in AppContainer), so camera and focus survive rotations and tab switches.
 */
class MapViewModel(
    private val api: MadovaiApi,
    private val linesStore: LinesStore,
    private val connectivity: ConnectivityMonitor,
    private val cotralVehicles: CotralViewportVehicleService,
    locationTracker: LocationTracker,
    private val scope: CoroutineScope,
) {
    private val _viewport = MutableStateFlow<MapViewport?>(null)
    val viewport: StateFlow<MapViewport?> = _viewport.asStateFlow()
    private val _poles = MutableStateFlow<List<Pole>>(emptyList())
    val poles: StateFlow<List<Pole>> = _poles.asStateFlow()
    private val _atacStops = MutableStateFlow<List<AtacStop>>(emptyList())
    val atacStops: StateFlow<List<AtacStop>> = _atacStops.asStateFlow()
    private val _viewportShapes = MutableStateFlow<List<MapShape>>(emptyList())
    val viewportShapes: StateFlow<List<MapShape>> = _viewportShapes.asStateFlow()
    /** Poles of a Cotral line picked in search (may lie outside the viewport); replaced on the next load. */
    private val _routePoles = MutableStateFlow<List<Pole>?>(null)
    val routePoles: StateFlow<List<Pole>?> = _routePoles.asStateFlow()
    /** True only while a load is slower than [Config.SLOW_REQUEST_HINT_DELAY_MS]. */
    private val _isLoading = MutableStateFlow(false)
    val isLoading: StateFlow<Boolean> = _isLoading.asStateFlow()
    private val _dataError = MutableStateFlow<ApiException?>(null)
    val dataError: StateFlow<ApiException?> = _dataError.asStateFlow()
    private val _linesVisible = MutableStateFlow(true)
    val linesVisible: StateFlow<Boolean> = _linesVisible.asStateFlow()
    private val _focus = MutableStateFlow<LineFocus?>(null)
    val focus: StateFlow<LineFocus?> = _focus.asStateFlow()
    /** "Nessun percorso trovato…" and similar, shown until dismissed. */
    private val _notice = MutableStateFlow<String?>(null)
    val notice: StateFlow<String?> = _notice.asStateFlow()
    private val _cameraRequest = MutableStateFlow<CameraRequest?>(null)
    val cameraRequest: StateFlow<CameraRequest?> = _cameraRequest.asStateFlow()

    val search = SearchModel(api, scope)

    /** Last camera, restored when the map is recreated (tab switch / rotation). Default: Rome. */
    var savedCenter: LatLon = LatLon(41.9028, 12.4964)
        private set
    var savedZoom: Double = 13.0
        private set

    private var settleJob: Job? = null
    private var loadJob: Job? = null
    private var focusJob: Job? = null

    init {
        // The first GPS fix only orients the very first viewport; afterwards the map is the
        // user's (a dedicated one-shot, never "no poles in view", which used to fight panning).
        scope.launch {
            val first = locationTracker.currentLocation.filterNotNull().first()
            _cameraRequest.value = CameraRequest.Center(first, USER_ZOOM)
        }
    }

    // region viewport

    fun onCameraChanged(bounds: ViewportBounds, center: LatLon, zoom: Double) {
        savedCenter = center
        savedZoom = zoom
        settleJob?.cancel()
        settleJob = scope.launch {
            delay(Config.VIEWPORT_SETTLE_DELAY_MS)
            val next = MapViewport(bounds, zoom)
            if (next != _viewport.value) {
                _viewport.value = next
                load()
            }
        }
    }

    fun reload() = load()

    fun toggleLines() {
        _linesVisible.value = !_linesVisible.value
        load()
    }

    private fun load() {
        loadJob?.cancel()
        val viewport = _viewport.value ?: return
        if (!viewport.showsData) {
            // A regional view would mean thousands of markers: show none (the map hints "Avvicina la mappa…").
            _poles.value = emptyList()
            _atacStops.value = emptyList()
            _viewportShapes.value = emptyList()
            _dataError.value = null
            _isLoading.value = false
            cotralVehicles.updateVisiblePoles(emptyList())
            return
        }
        val bounds = viewport.bounds.padded
        val wantShapes = _linesVisible.value
        loadJob = scope.launch {
            val hint = launch {
                delay(Config.SLOW_REQUEST_HINT_DELAY_MS)
                _isLoading.value = true
            }
            try {
                // coroutineScope: a failing request surfaces here as an exception instead of
                // cancelling (and crashing through) the parent job.
                val (s, sh) = coroutineScope {
                    val stops = async { api.stops(bounds) }
                    val shapes = async { if (wantShapes) api.shapes(bounds) else emptyList() }
                    stops.await() to shapes.await()
                }
                _poles.value = s.poles
                _atacStops.value = s.atacStops
                _viewportShapes.value = sh
                _routePoles.value = null
                _dataError.value = null
                cotralVehicles.updateVisiblePoles(s.poles)
                connectivity.reportSuccess()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // Keep whatever is already on the map; the banner explains and offers a retry.
                _dataError.value = e as? ApiException ?: ApiException.offline()
                connectivity.report(e)
            } finally {
                hint.cancel()
                _isLoading.value = false
            }
        }
    }

    fun consumeCameraRequest(request: CameraRequest) {
        if (_cameraRequest.value == request) _cameraRequest.value = null
    }

    fun centerOn(location: LatLon, zoom: Double = POLE_ZOOM) {
        _cameraRequest.value = CameraRequest.Center(location, zoom)
    }

    fun dismissNotice() {
        _notice.value = null
    }

    // endregion

    // region focus

    /** Isolates a line: an Atac route id, or a Cotral vehicle's `percorso` (a rail code is mapped to its GTFS line). */
    fun focus(routeId: String?) {
        focusJob?.cancel()
        if (routeId.isNullOrBlank()) {
            _focus.value = null
            return
        }
        val current = _focus.value
        if (current?.routeId == routeId && current.kind != LineFocus.Kind.UNKNOWN) return
        _focus.value = LineFocus(routeId, LineFocus.Kind.LOADING)
        focusJob = scope.launch {
            val resolved = resolveFocus(routeId)
            if (_focus.value?.routeId == routeId) _focus.value = resolved
        }
    }

    fun clearFocus() {
        focusJob?.cancel()
        _focus.value = null
    }

    private suspend fun resolveFocus(routeId: String): LineFocus {
        CotralTrainRoute.fromRaw(routeId)?.let { train ->
            val rail = linesStore.loadOrNull()?.cotralRail?.firstOrNull { it.shortName.uppercase() == train.gtfsRouteShortName }
                ?: return LineFocus(routeId, LineFocus.Kind.UNKNOWN)
            return try {
                val detail = api.line("cotral", rail.routeId)
                LineFocus(routeId, LineFocus.Kind.COTRAL, detail.route, emptyList(), detail.shapes)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                LineFocus(routeId, LineFocus.Kind.UNKNOWN)
            }
        }
        return try {
            val detail = api.line("atac", routeId)
            LineFocus(routeId, LineFocus.Kind.ATAC, detail.route, detail.stops.map { it.asAtacStop() }, detail.shapes)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // A Cotral bus `percorso` has no shape: the focus still filters vehicles, it just can't draw the line.
            LineFocus(routeId, LineFocus.Kind.UNKNOWN)
        }
    }

    // endregion

    // region search selections

    fun selectStop(stop: SearchStop) {
        centerOn(stop.coordinate, POLE_ZOOM)
    }

    /** A Cotral line from search: show all its stops right away and fit the camera. False (+ notice) if nothing to show. */
    suspend fun showCotralRoute(route: RouteInfo): Boolean {
        _notice.value = null
        return try {
            val detail = api.line("cotral", route.routeId)
            if (detail.stops.isEmpty()) {
                _notice.value = "Nessuna fermata trovata per la linea \"${route.shortName}\"."
                return false
            }
            clearFocus()
            _routePoles.value = detail.stops.map { Pole.fromStop(it.id, it.name, null, it.lat, it.lon, route.rail) }
            _cameraRequest.value = CameraRequest.Fit(detail.stops.map { LatLon(it.lat, it.lon) }, 14.0)
            true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            _notice.value = e.userMessage
            false
        }
    }

    /** An Atac line from search: fit its shape and focus it. */
    suspend fun showAtacRoute(route: RouteInfo) {
        _notice.value = null
        focusJob?.cancel()
        try {
            val detail = api.line("atac", route.routeId)
            val points = detail.shapes.flatMap { it.points }.ifEmpty { detail.stops.map { LatLon(it.lat, it.lon) } }
            if (points.isEmpty()) {
                _notice.value = "Nessun percorso trovato per la linea \"${route.title}\"."
                return
            }
            _cameraRequest.value = CameraRequest.Fit(points, 15.0)
            _focus.value = LineFocus(route.routeId, LineFocus.Kind.ATAC, detail.route, detail.stops.map { it.asAtacStop() }, detail.shapes)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            _notice.value = e.userMessage
        }
    }

    // endregion

    companion object {
        const val USER_ZOOM = 16.0
        const val POLE_ZOOM = 16.0

        /** The vehicles to draw: the focused line's at any zoom, otherwise those in the padded viewport above zoom 11. Pure, for tests. */
        fun visibleVehicles(all: List<TransitVehicle>, focusRouteId: String?, viewport: MapViewport?): List<TransitVehicle> {
            if (focusRouteId != null) return all.filter { it.routeId == focusRouteId }
            if (viewport == null || viewport.zoom < Config.MIN_VEHICLE_ZOOM) return emptyList()
            val box = viewport.bounds.padded
            return all.filter { box.contains(it.coordinate) }
        }

        /** Atac stops to draw: one pin per station (platforms grouped by name). */
        fun shownAtacStops(focus: LineFocus?, viewportStops: List<AtacStop>): List<AtacStop> = when {
            focus == null -> groupedStopsByName(viewportStops).map { it.anchor }
            focus.kind == LineFocus.Kind.ATAC -> groupedStopsByName(focus.stops).map { it.anchor }
            else -> emptyList()
        }
    }
}

/**
 * "Cerca una fermata o una linea…" — the matching runs server-side (`search`), debounced;
 * a newer query cancels the previous request. [stopFilter] lets the reminder form hide
 * Atac metro stations.
 */
class SearchModel(
    private val api: MadovaiApi,
    private val scope: CoroutineScope,
    private val includeRoutes: Boolean = true,
    private val stopFilter: (SearchStop) -> Boolean = { true },
) {
    private val _query = MutableStateFlow("")
    val query: StateFlow<String> = _query.asStateFlow()
    private val _results = MutableStateFlow(SearchResults.EMPTY)
    val results: StateFlow<SearchResults> = _results.asStateFlow()
    private val _isSearching = MutableStateFlow(false)
    val isSearching: StateFlow<Boolean> = _isSearching.asStateFlow()
    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()
    /** How many stops [stopFilter] removed from the last results (e.g. "metro not available"). */
    private val _filteredOut = MutableStateFlow(0)
    val filteredOut: StateFlow<Int> = _filteredOut.asStateFlow()

    private var job: Job? = null

    fun onQueryChange(text: String) {
        _query.value = text
        job?.cancel()
        val q = text.trim()
        if (q.isEmpty()) {
            _results.value = SearchResults.EMPTY
            _isSearching.value = false
            _error.value = null
            _filteredOut.value = 0
            return
        }
        job = scope.launch {
            delay(Config.SEARCH_DEBOUNCE_MS)
            _isSearching.value = true
            try {
                val res = api.search(q)
                val stops = res.stops.filter(stopFilter)
                _filteredOut.value = res.stops.size - stops.size
                _results.value = SearchResults(stops, if (includeRoutes) res.routes else emptyList())
                _error.value = null
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _results.value = SearchResults.EMPTY
                _error.value = e.userMessage
            } finally {
                _isSearching.value = false
            }
        }
    }

    fun clear() {
        job?.cancel()
        _query.value = ""
        _results.value = SearchResults.EMPTY
        _isSearching.value = false
        _error.value = null
        _filteredOut.value = 0
    }
}
