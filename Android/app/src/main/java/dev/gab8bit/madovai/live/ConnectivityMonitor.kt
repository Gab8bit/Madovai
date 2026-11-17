package dev.gab8bit.madovai.live

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import dev.gab8bit.madovai.api.ApiException
import dev.gab8bit.madovai.api.MadovaiApi
import dev.gab8bit.madovai.api.userMessage
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Whether the phone is online and whether the backend is ready, for the banners at the top
 * of the map (port of iOS `ConnectivityMonitor`). Services register [onReconnect] to refresh
 * right away when the connection comes back instead of waiting a full interval.
 */
class ConnectivityMonitor(context: Context, private val api: MadovaiApi, private val scope: CoroutineScope) {
    sealed interface ServerState {
        data object Unknown : ServerState
        data object Ready : ServerState
        /** `gtfsReady == false` / 503: the server is (re)building its static data. */
        data object Preparing : ServerState
        /** Online but the backend can't be reached / answers with errors. */
        data class Unreachable(val message: String) : ServerState
    }

    private val manager = context.applicationContext.getSystemService(ConnectivityManager::class.java)
    private val _isOnline = MutableStateFlow(true)
    val isOnline: StateFlow<Boolean> = _isOnline.asStateFlow()
    private val _serverState = MutableStateFlow<ServerState>(ServerState.Unknown)
    val serverState: StateFlow<ServerState> = _serverState.asStateFlow()

    private val reconnectHandlers = ArrayList<() -> Unit>()
    private var healthJob: Job? = null
    private var started = false

    fun start() {
        if (started) return
        started = true
        _isOnline.value = currentlyOnline()
        runCatching {
            manager?.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) = post()
                override fun onLost(network: Network) = post()
                override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) = post()
            })
        }
        checkServer()
    }

    private fun post() {
        scope.launch { update(currentlyOnline()) }
    }

    private fun currentlyOnline(): Boolean = runCatching {
        val caps = manager?.getNetworkCapabilities(manager.activeNetwork) ?: return@runCatching false
        caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }.getOrDefault(true)

    fun onReconnect(handler: () -> Unit) {
        reconnectHandlers.add(handler)
    }

    /** A loader succeeded: a stale "server unreachable" banner disappears without waiting for a probe. */
    fun reportSuccess() {
        val s = _serverState.value
        if (s != ServerState.Ready && s != ServerState.Preparing) _serverState.value = ServerState.Ready
    }

    /** A loader failed: 503 means "preparing", a transport failure while online triggers a health probe. */
    fun report(error: Throwable) {
        val e = error as? ApiException ?: return
        when {
            e.kind == ApiException.Kind.NOT_READY -> {
                _serverState.value = ServerState.Preparing
                scheduleHealthCheck(20_000)
            }
            _isOnline.value && (e.kind == ApiException.Kind.OFFLINE || e.kind == ApiException.Kind.TIMEOUT) -> checkServer()
        }
    }

    fun checkServer() {
        healthJob?.cancel()
        healthJob = scope.launch {
            try {
                val health = api.health()
                _serverState.value = if (health.gtfsReady) ServerState.Ready else ServerState.Preparing
                if (!health.gtfsReady) scheduleHealthCheck(20_000)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _serverState.value = if (_isOnline.value) ServerState.Unreachable(e.userMessage) else ServerState.Unknown
                if (_isOnline.value) scheduleHealthCheck(30_000)
            }
        }
    }

    private fun scheduleHealthCheck(afterMs: Long) {
        healthJob?.cancel()
        healthJob = scope.launch {
            delay(afterMs)
            checkServer()
        }
    }

    private fun update(online: Boolean) {
        val wasOffline = !_isOnline.value
        _isOnline.value = online
        if (online && wasOffline) {
            checkServer()
            reconnectHandlers.forEach { it() }
        }
    }
}
