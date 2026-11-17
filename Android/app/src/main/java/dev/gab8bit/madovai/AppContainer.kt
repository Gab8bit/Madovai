package dev.gab8bit.madovai

import android.content.Context
import android.util.Log
import dev.gab8bit.madovai.api.MadovaiApi
import dev.gab8bit.madovai.live.AtacFleetService
import dev.gab8bit.madovai.live.ConnectivityMonitor
import dev.gab8bit.madovai.live.CotralViewportVehicleService
import dev.gab8bit.madovai.live.LinesStore
import dev.gab8bit.madovai.live.VehicleTracker
import dev.gab8bit.madovai.reminders.ReminderNotifier
import dev.gab8bit.madovai.reminders.ReminderScheduler
import dev.gab8bit.madovai.reminders.ReminderStore
import dev.gab8bit.madovai.service.FavoritesStore
import dev.gab8bit.madovai.service.LocationTracker
import dev.gab8bit.madovai.ui.MapViewModel
import dev.gab8bit.madovai.ui.SheetHostState
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Manual dependency container, one per process. Everything talks to the Madovai backend
 * through the single [api]; live services poll only while the app is in the foreground.
 */
class AppContainer(context: Context) {
    /**
     * Main-thread scope: services mutate their state here, like the iOS @MainActor classes.
     * Every loader catches its own errors; the handler is a last line of defence so an
     * unexpected one is logged instead of taking the whole app down.
     */
    val appScope = CoroutineScope(
        SupervisorJob() + Dispatchers.Main.immediate + CoroutineExceptionHandler { _, e -> Log.w("Madovai", "Unhandled error", e) },
    )

    private val _isForeground = MutableStateFlow(false)
    /** True between the activity's ON_START and ON_STOP: every poller waits on it. */
    val isForeground: StateFlow<Boolean> = _isForeground.asStateFlow()

    val api = MadovaiApi.create()
    val connectivity = ConnectivityMonitor(context, api, appScope)
    val linesStore = LinesStore(api)

    // Live
    val atacFleet = AtacFleetService(api, appScope, isForeground, connectivity)
    val cotralVehicles = CotralViewportVehicleService(api, appScope, isForeground)
    val vehicleTracker = VehicleTracker(api, appScope, isForeground)

    // Local state
    val favoritesStore = FavoritesStore(context, appScope)
    val locationTracker = LocationTracker(context)
    val reminderScheduler = ReminderScheduler(context)
    val reminderNotifier = ReminderNotifier(context)
    val reminderStore = ReminderStore(context, appScope, reminderScheduler)

    // Presentation state (process-scoped: survives rotation and tab switches)
    val mapViewModel = MapViewModel(api, linesStore, connectivity, cotralVehicles, locationTracker, appScope)
    val sheets = SheetHostState()
    /** Location permission is requested automatically at most once per launch. */
    var hasRequestedLocationPermission = false

    private var started = false

    init {
        connectivity.onReconnect {
            atacFleet.refreshNow()
            cotralVehicles.refreshNow()
            mapViewModel.reload()
        }
    }

    fun onForeground() {
        if (!started) {
            started = true
            connectivity.start()
            atacFleet.start()
            cotralVehicles.start()
        }
        _isForeground.value = true
        if (locationTracker.hasPermission()) locationTracker.startUpdating()
    }

    fun onBackground() {
        _isForeground.value = false
        locationTracker.stopUpdating()
    }

    /** "Riprova" on the banners: probe the server and refresh everything now. */
    fun retryAll() {
        connectivity.checkServer()
        atacFleet.refreshNow()
        cotralVehicles.refreshNow()
        mapViewModel.reload()
    }
}
