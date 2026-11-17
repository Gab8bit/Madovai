package dev.gab8bit.madovai.live

import dev.gab8bit.madovai.Config
import dev.gab8bit.madovai.api.ApiException
import dev.gab8bit.madovai.api.MadovaiApi
import dev.gab8bit.madovai.model.LatLon
import dev.gab8bit.madovai.model.LinesCatalog
import dev.gab8bit.madovai.model.Pole
import dev.gab8bit.madovai.model.TransitVehicle
import dev.gab8bit.madovai.model.VehicleTrackingState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** The whole Atac / Roma TPL fleet, refreshed every [Config.ATAC_FLEET_POLL_INTERVAL_MS] while in foreground. */
class AtacFleetService(
    private val api: MadovaiApi,
    scope: CoroutineScope,
    foreground: StateFlow<Boolean>,
    private val connectivity: ConnectivityMonitor?,
) {
    private val _vehicles = MutableStateFlow<List<TransitVehicle>>(emptyList())
    val vehicles: StateFlow<List<TransitVehicle>> = _vehicles.asStateFlow()
    /** Last refresh failed (vehicles keep their last known positions). */
    private val _error = MutableStateFlow<ApiException?>(null)
    val error: StateFlow<ApiException?> = _error.asStateFlow()
    private val _hasLoadedOnce = MutableStateFlow(false)
    val hasLoadedOnce: StateFlow<Boolean> = _hasLoadedOnce.asStateFlow()

    private val poller = Poller(scope, Config.ATAC_FLEET_POLL_INTERVAL_MS, foreground) { refresh() }

    fun start() = poller.start()
    fun refreshNow() = poller.refreshNow()

    private suspend fun refresh() {
        try {
            _vehicles.value = api.atacVehicles().vehicles
            _error.value = null
            _hasLoadedOnce.value = true
            connectivity?.reportSuccess()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            _error.value = e as? ApiException ?: ApiException.offline()
            connectivity?.report(e)
        }
    }
}

/**
 * Cotral vehicles near the visible poles. There's no "every Cotral vehicle" feed: a vehicle
 * only shows up through the transits of a pole it serves, so this asks the backend about
 * whichever poles are on screen (server-side fan-out, max 15 poles).
 */
class CotralViewportVehicleService(
    private val api: MadovaiApi,
    private val scope: CoroutineScope,
    foreground: StateFlow<Boolean>,
) {
    private val _vehicles = MutableStateFlow<List<TransitVehicle>>(emptyList())
    val vehicles: StateFlow<List<TransitVehicle>> = _vehicles.asStateFlow()

    private var poleCodes: List<String> = emptyList()
    private var byId: Map<String, TransitVehicle> = emptyMap()
    private var misses: Map<String, Int> = emptyMap()
    /** Serialises every trigger (timer + viewport): two scans can never finish out of order and overwrite each other. */
    private val gate = Mutex()
    private var needsRescan = false

    private val poller = Poller(scope, Config.COTRAL_VIEWPORT_VEHICLE_POLL_INTERVAL_MS, foreground) { requestScan() }

    fun start() = poller.start()
    fun refreshNow() = poller.refreshNow()

    /** Called whenever the visible Cotral poles change (viewport settle). */
    fun updateVisiblePoles(poles: List<Pole>) {
        val codes = poles.mapNotNull { it.code }.distinct().take(Config.COTRAL_VIEWPORT_POLE_QUERY_LIMIT)
        if (codes == poleCodes) return
        poleCodes = codes
        scope.launch { requestScan() }
    }

    private suspend fun requestScan() {
        if (gate.isLocked) {
            needsRescan = true
            return
        }
        gate.withLock {
            scan()
            while (needsRescan) {
                needsRescan = false
                scan()
            }
        }
    }

    private suspend fun scan() {
        val codes = poleCodes
        if (codes.isEmpty()) {
            byId = emptyMap()
            misses = emptyMap()
            if (_vehicles.value.isNotEmpty()) _vehicles.value = emptyList()
            return
        }
        val fresh = try {
            api.cotralVehicles(codes)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            return
        }
        val merged = merge(byId, misses, fresh, Config.VEHICLE_TRACKING_LOSS_THRESHOLD)
        byId = merged.first
        misses = merged.second
        _vehicles.value = merged.first.values.sortedBy { it.id }
    }

    companion object {
        /**
         * A vehicle missing from one scan (any hiccup in the two upstream round trips behind
         * it) keeps its last position for up to [lossThreshold] scans instead of blinking off
         * the map and back. Pure, for tests.
         */
        fun merge(
            previous: Map<String, TransitVehicle>,
            previousMisses: Map<String, Int>,
            fresh: List<TransitVehicle>,
            lossThreshold: Int,
        ): Pair<Map<String, TransitVehicle>, Map<String, Int>> {
            val byId = LinkedHashMap<String, TransitVehicle>()
            val misses = HashMap<String, Int>()
            for (v in fresh) {
                byId[v.id] = v
                misses[v.id] = 0
            }
            for ((id, v) in previous) {
                if (byId.containsKey(id)) continue
                val count = (previousMisses[id] ?: 0) + 1
                if (count > lossThreshold) continue
                byId[id] = v
                misses[id] = count
            }
            return byId to misses
        }
    }
}

/**
 * The single Cotral vehicle the user chose to follow ("Segui"), owned app-wide so the marker
 * keeps moving after its sheet is closed. Polls only in foreground.
 */
class VehicleTracker(private val api: MadovaiApi, private val scope: CoroutineScope, private val foreground: StateFlow<Boolean>) {
    private val _vehicleCode = MutableStateFlow<String?>(null)
    val vehicleCode: StateFlow<String?> = _vehicleCode.asStateFlow()
    private val _isTreno = MutableStateFlow(false)
    val isTreno: StateFlow<Boolean> = _isTreno.asStateFlow()
    private val _coordinate = MutableStateFlow<LatLon?>(null)
    val coordinate: StateFlow<LatLon?> = _coordinate.asStateFlow()
    private val _state = MutableStateFlow<VehicleTrackingState>(VehicleTrackingState.Idle)
    val state: StateFlow<VehicleTrackingState> = _state.asStateFlow()

    private var lastUpdated: Long? = null
    private var poller: Poller? = null
    private var consecutiveMisses = 0

    fun isFollowing(code: String?): Boolean = code != null && _vehicleCode.value == code

    fun toggleFollowing(code: String, isTreno: Boolean = false) {
        if (isFollowing(code)) stopFollowing() else startFollowing(code, isTreno)
    }

    fun startFollowing(code: String, isTreno: Boolean = false) {
        poller?.stop()
        _vehicleCode.value = code
        _isTreno.value = isTreno
        _coordinate.value = null
        lastUpdated = null
        _state.value = VehicleTrackingState.Tracking
        consecutiveMisses = 0
        poller = Poller(scope, Config.VEHICLE_POSITION_POLL_INTERVAL_MS, foreground) { refresh(code) }.also { it.start() }
    }

    fun stopFollowing() {
        poller?.stop()
        poller = null
        _vehicleCode.value = null
        _isTreno.value = false
        _coordinate.value = null
        lastUpdated = null
        _state.value = VehicleTrackingState.Idle
        consecutiveMisses = 0
    }

    /** A pole's transit poll saw `vehicleAlive == false` for the followed vehicle — quicker than waiting out the misses. */
    fun reportOffline(code: String) {
        if (_vehicleCode.value != code || _state.value == VehicleTrackingState.Idle) return
        markLost()
    }

    private suspend fun refresh(code: String) {
        try {
            val position = api.cotralVehicle(code)
            if (_vehicleCode.value != code) return
            if (position != null) {
                _coordinate.value = position
                _state.value = VehicleTrackingState.Tracking
                lastUpdated = System.currentTimeMillis()
                consecutiveMisses = 0
            } else {
                registerMiss()
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (_vehicleCode.value == code) registerMiss()
        }
    }

    private fun registerMiss() {
        consecutiveMisses += 1
        if (consecutiveMisses >= Config.VEHICLE_TRACKING_LOSS_THRESHOLD) markLost()
    }

    private fun markLost() {
        if (_state.value == VehicleTrackingState.Idle) return
        _state.value = VehicleTrackingState.Lost(lastUpdated)
    }
}

/** The "Linee" catalogue is the same for everyone (~440 rows): fetched once per process, retried on failure. */
class LinesStore(private val api: MadovaiApi) {
    private val mutex = Mutex()
    private val _lines = MutableStateFlow<LinesCatalog?>(null)
    val lines: StateFlow<LinesCatalog?> = _lines.asStateFlow()

    /** Throws (ApiException) on failure so the caller can show it; a later call retries. */
    suspend fun load(): LinesCatalog = mutex.withLock {
        _lines.value ?: api.lines().also { _lines.value = it }
    }

    suspend fun loadOrNull(): LinesCatalog? = try {
        load()
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        null
    }
}
