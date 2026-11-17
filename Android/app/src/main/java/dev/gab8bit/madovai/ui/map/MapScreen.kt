package dev.gab8bit.madovai.ui.map

import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.LocationOff
import androidx.compose.material.icons.filled.MyLocation
import androidx.compose.material.icons.filled.Place
import androidx.compose.material.icons.filled.Route
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.outlined.DirectionsBus
import androidx.compose.material.icons.outlined.HourglassTop
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.LocationOff
import androidx.compose.material.icons.outlined.Route
import androidx.compose.material.icons.outlined.SearchOff
import androidx.compose.material.icons.outlined.WifiOff
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SearchBar
import androidx.compose.material3.SearchBarDefaults
import androidx.compose.material3.SmallFloatingActionButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.gab8bit.madovai.AppContainer
import dev.gab8bit.madovai.Config
import dev.gab8bit.madovai.live.ConnectivityMonitor
import dev.gab8bit.madovai.model.AtacStop
import dev.gab8bit.madovai.model.AtacStopGroup
import dev.gab8bit.madovai.model.MapShape
import dev.gab8bit.madovai.model.RouteInfo
import dev.gab8bit.madovai.model.SearchStop
import dev.gab8bit.madovai.model.TransitVehicleKind
import dev.gab8bit.madovai.model.VehicleTrackingState
import dev.gab8bit.madovai.service.LocationTracker
import dev.gab8bit.madovai.ui.LineFocus
import dev.gab8bit.madovai.ui.MapViewModel
import dev.gab8bit.madovai.ui.SheetRoute
import dev.gab8bit.madovai.ui.common.BannerCard
import dev.gab8bit.madovai.ui.common.ErrorBanner
import dev.gab8bit.madovai.ui.common.HintPill
import dev.gab8bit.madovai.ui.common.kindIcon
import dev.gab8bit.madovai.ui.theme.TransitColors
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/**
 * Resolves a tapped/searched Atac platform to its whole station (every platform sharing the
 * name, `atac-stop`), labelled for [routeId] when the station was opened from a line.
 */
suspend fun AppContainer.atacStationGroup(stop: AtacStop, routeId: String? = null): AtacStopGroup {
    val platforms = try {
        api.atacStop(stop.stopId, routeId)
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        emptyList()
    }
    val list = platforms.ifEmpty { listOf(stop) }
    return AtacStopGroup(list.first().stopName.trim().ifEmpty { stop.stopName }, list.sortedBy { it.stopId })
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MapScreen(container: AppContainer, onRequestLocationPermission: () -> Unit) {
    val vm = container.mapViewModel
    val scope = rememberCoroutineScope()

    val viewport by vm.viewport.collectAsState()
    val poles by vm.poles.collectAsState()
    val routePoles by vm.routePoles.collectAsState()
    val atacStops by vm.atacStops.collectAsState()
    val viewportShapes by vm.viewportShapes.collectAsState()
    val linesVisible by vm.linesVisible.collectAsState()
    val focus by vm.focus.collectAsState()
    val isLoading by vm.isLoading.collectAsState()
    val dataError by vm.dataError.collectAsState()
    val notice by vm.notice.collectAsState()
    val cameraRequest by vm.cameraRequest.collectAsState()

    val atacVehicles by container.atacFleet.vehicles.collectAsState()
    val fleetError by container.atacFleet.error.collectAsState()
    val fleetLoaded by container.atacFleet.hasLoadedOnce.collectAsState()
    val cotralVehicles by container.cotralVehicles.vehicles.collectAsState()
    val favoriteIds by container.favoritesStore.favoriteIds.collectAsState()
    val trackerCode by container.vehicleTracker.vehicleCode.collectAsState()
    val trackerCoordinate by container.vehicleTracker.coordinate.collectAsState()
    val trackerIsTreno by container.vehicleTracker.isTreno.collectAsState()
    val trackerState by container.vehicleTracker.state.collectAsState()
    val userLocation by container.locationTracker.currentLocation.collectAsState()
    val permission by container.locationTracker.permission.collectAsState()
    val isOnline by container.connectivity.isOnline.collectAsState()
    val serverState by container.connectivity.serverState.collectAsState()

    val shownPoles = if (focus == null) routePoles ?: poles else emptyList()
    val shownAtacStops = remember(focus, atacStops) { MapViewModel.shownAtacStops(focus, atacStops) }
    val shownShapes = focus?.shapes ?: if (linesVisible) viewportShapes else emptyList()
    val allVehicles = remember(atacVehicles, cotralVehicles) { atacVehicles + cotralVehicles }
    val shownVehicles = remember(allVehicles, focus, viewport) { MapViewModel.visibleVehicles(allVehicles, focus?.routeId, viewport) }
    val favoritePoleIds = remember(favoriteIds) { favoriteIds.filter { it.startsWith("cotral:") }.mapTo(HashSet()) { it.removePrefix("cotral:") } }
    val followed = trackerCoordinate?.let { FollowedVehicle(it, trackerIsTreno, trackerState is VehicleTrackingState.Lost) }
    val zoom = viewport?.zoom ?: vm.savedZoom

    var searchExpanded by rememberSaveable { mutableStateOf(false) }

    fun openAtacStation(stop: AtacStop, routeId: String?) {
        scope.launch { container.sheets.push(SheetRoute.AtacStation(container.atacStationGroup(stop, routeId), routeId)) }
    }

    Box(Modifier.fillMaxSize()) {
        OsmMap(
            modifier = Modifier.fillMaxSize(),
            initialCenter = vm.savedCenter,
            initialZoom = vm.savedZoom,
            darkTheme = isSystemInDarkTheme(),
            poles = shownPoles,
            favoritePoleIds = favoritePoleIds,
            atacStops = shownAtacStops,
            shapes = shownShapes,
            shapeColor = ::shapeColor,
            vehicles = shownVehicles,
            vehicleBadges = zoom >= Config.VEHICLE_BADGE_ZOOM,
            followed = followed,
            userLocation = userLocation,
            cameraRequest = cameraRequest,
            onCameraRequestConsumed = vm::consumeCameraRequest,
            onCameraChanged = vm::onCameraChanged,
            onPoleClick = { container.sheets.push(SheetRoute.CotralPole(it)) },
            onAtacStopClick = { stop -> openAtacStation(stop, focus?.takeIf { it.kind == LineFocus.Kind.ATAC }?.routeId) },
            onVehicleClick = { vehicle ->
                container.sheets.push(SheetRoute.Vehicle(vehicle))
                vm.focus(vehicle.routeId)
            },
        )

        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            MapSearchBar(
                vm = vm,
                expanded = searchExpanded,
                setExpanded = { searchExpanded = it },
                onStop = { stop ->
                    vm.selectStop(stop)
                    if (stop.isCotral) container.sheets.push(SheetRoute.CotralPole(stop.asPole())) else openAtacStation(stop.asAtacStop(), null)
                },
                onRoute = { route ->
                    scope.launch {
                        if (route.isCotral) {
                            // Its stations (with tappable schedules) — otherwise a tap would land on whichever pole is nearest.
                            if (vm.showCotralRoute(route)) container.sheets.push(SheetRoute.Line(route))
                        } else {
                            vm.showAtacRoute(route)
                        }
                    }
                },
            )

            if (!searchExpanded) Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                StatusBanners(
                    container = container,
                    isOnline = isOnline,
                    serverState = serverState,
                    dataErrorMessage = dataError?.message,
                    fleetErrorMessage = fleetError?.message?.takeIf { atacVehicles.isEmpty() || !fleetLoaded },
                )
                if (isLoading && dataError == null && isOnline) {
                    HintPill("Caricamento dati…", Modifier.align(Alignment.CenterHorizontally), spinner = true)
                }
                focus?.let { FocusBanner(it, onReset = vm::clearFocus) }
                if (trackerCode != null) TrackingMapBanner(container, trackerCode!!, trackerIsTreno, trackerState is VehicleTrackingState.Lost)
                notice?.let { message ->
                    BannerCard(Icons.Outlined.SearchOff, "Nessun risultato", message) {
                        TextButton(onClick = vm::dismissNotice) { Text("Chiudi") }
                    }
                }
                if (permission == LocationTracker.Permission.DENIED) PermissionDeniedBanner()
            }
        }

        if (!searchExpanded && focus == null && viewport?.showsData == false) {
            HintPill(
                if (zoom < Config.MIN_VEHICLE_ZOOM) "Avvicina la mappa per vedere mezzi e fermate" else "Avvicina la mappa per vedere le fermate",
                Modifier.align(Alignment.BottomCenter).padding(bottom = 24.dp),
            )
        }

        if (!searchExpanded) Column(
            Modifier.align(Alignment.BottomEnd).padding(end = 16.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            horizontalAlignment = Alignment.End,
        ) {
            SmallFloatingActionButton(onClick = { container.sheets.push(SheetRoute.Info) }) {
                Icon(Icons.Outlined.Info, contentDescription = "Informazioni")
            }
            SmallFloatingActionButton(onClick = vm::toggleLines) {
                Icon(
                    if (linesVisible) Icons.Filled.Route else Icons.Outlined.Route,
                    contentDescription = if (linesVisible) "Nascondi le linee" else "Mostra le linee",
                    tint = if (linesVisible) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            FloatingActionButton(onClick = {
                val loc = userLocation
                if (loc != null) vm.centerOn(loc, MapViewModel.USER_ZOOM) else onRequestLocationPermission()
            }) {
                Icon(Icons.Filled.MyLocation, contentDescription = "La mia posizione")
            }
        }
    }
}

@Composable
private fun StatusBanners(
    container: AppContainer,
    isOnline: Boolean,
    serverState: ConnectivityMonitor.ServerState,
    dataErrorMessage: String?,
    fleetErrorMessage: String?,
) {
    when {
        !isOnline -> BannerCard(
            Icons.Outlined.WifiOff,
            "Sei offline",
            "Controlla la connessione: posizioni e orari non si aggiornano finché non torni online.",
            error = true,
        )
        serverState == ConnectivityMonitor.ServerState.Preparing -> BannerCard(
            Icons.Outlined.HourglassTop,
            "Dati non ancora disponibili",
            "Il server sta preparando i dati delle linee. Riprova tra qualche minuto.",
            iconTint = TransitColors.CotralOrange,
        ) { TextButton(onClick = container::retryAll) { Text("Riprova") } }
        serverState is ConnectivityMonitor.ServerState.Unreachable ->
            ErrorBanner(serverState.message, onRetry = container::retryAll, title = "Server non raggiungibile")
        dataErrorMessage != null -> ErrorBanner(message = dataErrorMessage, onRetry = container::retryAll)
        fleetErrorMessage != null -> BannerCard(Icons.Outlined.DirectionsBus, "Veicoli non disponibili", fleetErrorMessage, iconTint = TransitColors.CotralOrange) {
            TextButton(onClick = container::retryAll) { Text("Riprova") }
        }
    }
}

private fun shapeColor(shape: MapShape): Color {
    shape.colorHex?.let { hex -> parseHex(hex)?.let { return it } }
    return when (shape.kind) {
        TransitVehicleKind.METRO -> TransitColors.Metro
        TransitVehicleKind.TRAM -> TransitColors.Tram
        TransitVehicleKind.TRENO -> TransitColors.Treno
        TransitVehicleKind.BUS -> TransitColors.BusLine
    }
}

private fun parseHex(hex: String): Color? {
    val s = hex.trim().removePrefix("#")
    if (s.length != 6) return null
    val v = s.toLongOrNull(16) ?: return null
    return Color(0xFF000000 or v)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun MapSearchBar(
    vm: MapViewModel,
    expanded: Boolean,
    setExpanded: (Boolean) -> Unit,
    onStop: (SearchStop) -> Unit,
    onRoute: (RouteInfo) -> Unit,
) {
    val search = vm.search
    val query by search.query.collectAsState()
    val results by search.results.collectAsState()
    val searching by search.isSearching.collectAsState()
    val error by search.error.collectAsState()

    fun pick(action: () -> Unit) {
        setExpanded(false)
        search.clear()
        action()
    }

    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.TopCenter) {
        SearchBar(
            inputField = {
                SearchBarDefaults.InputField(
                    query = query,
                    onQueryChange = search::onQueryChange,
                    onSearch = { },
                    expanded = expanded,
                    onExpandedChange = setExpanded,
                    placeholder = { Text("Cerca una fermata o una linea…") },
                    leadingIcon = {
                        if (expanded) IconButton(onClick = { setExpanded(false) }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Indietro") }
                        else Icon(Icons.Filled.Search, null)
                    },
                    trailingIcon = {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            if (searching) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                            if (query.isNotEmpty()) IconButton(onClick = search::clear) { Icon(Icons.Filled.Close, "Cancella") }
                        }
                    },
                )
            },
            expanded = expanded,
            onExpandedChange = setExpanded,
            modifier = if (expanded) Modifier else Modifier.padding(horizontal = 16.dp),
        ) {
            LazyColumn(Modifier.fillMaxSize()) {
                if (results.routes.isNotEmpty()) {
                    item { ResultsHeader("Linee") }
                    items(results.routes, key = { it.id }) { r ->
                        ListItem(
                            headlineContent = { Text(r.title, fontWeight = FontWeight.SemiBold) },
                            supportingContent = {
                                Text(listOfNotNull(r.operatorLabel, r.subtitleName).joinToString(" · "), maxLines = 1, overflow = TextOverflow.Ellipsis)
                            },
                            leadingContent = { Icon(kindIcon(r.iconKind), null) },
                            modifier = Modifier.clickable { pick { onRoute(r) } },
                        )
                    }
                }
                if (results.stops.isNotEmpty()) {
                    item { ResultsHeader("Fermate") }
                    items(results.stops, key = { it.id }) { s ->
                        ListItem(
                            headlineContent = { Text(s.name) },
                            supportingContent = { Text(s.subtitle) },
                            leadingContent = {
                                Icon(if (s.isCotral) kindIcon(if (s.rail) TransitVehicleKind.TRENO else TransitVehicleKind.BUS) else Icons.Filled.Place, null)
                            },
                            modifier = Modifier.clickable { pick { onStop(s) } },
                        )
                    }
                }
                val q = query.trim()
                if (q.isNotEmpty() && !searching && results.routes.isEmpty() && results.stops.isEmpty()) {
                    item {
                        Text(
                            error ?: "Nessun risultato per \"$q\".",
                            modifier = Modifier.padding(24.dp),
                            color = if (error != null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun ResultsHeader(title: String) {
    Column {
        Text(title, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(start = 16.dp, top = 16.dp, bottom = 4.dp))
        HorizontalDivider()
    }
}

@Composable
private fun FocusBanner(focus: LineFocus, onReset: () -> Unit) {
    BannerCard(
        icon = Icons.Filled.Route,
        title = "Mostro solo questa linea",
        message = focus.title,
        iconTint = MaterialTheme.colorScheme.primary,
    ) {
        if (focus.kind == LineFocus.Kind.LOADING) {
            CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
            Spacer(Modifier.width(8.dp))
        }
        TextButton(onClick = onReset) {
            Icon(Icons.Filled.Close, null, Modifier.size(18.dp))
            Spacer(Modifier.width(4.dp))
            Text("Reset")
        }
    }
}

/** The followed Cotral vehicle ("Segui"), visible on the map even after its sheet is closed. */
@Composable
private fun TrackingMapBanner(container: AppContainer, code: String, isTreno: Boolean, lost: Boolean) {
    BannerCard(
        icon = if (lost) Icons.Outlined.LocationOff else Icons.Filled.MyLocation,
        title = if (lost) "Tracking interrotto" else "Seguendo ${if (isTreno) "treno" else "bus"} $code",
        message = if (lost) "Il veicolo $code non trasmette più la posizione" else "Posizione aggiornata ogni ${Config.VEHICLE_POSITION_POLL_INTERVAL_MS / 1000}s",
        error = lost,
        iconTint = if (lost) MaterialTheme.colorScheme.error else TransitColors.CotralOrange,
    ) {
        TextButton(onClick = { container.vehicleTracker.stopFollowing() }) { Text("Ferma") }
    }
}

@Composable
private fun PermissionDeniedBanner() {
    val context = LocalContext.current
    BannerCard(
        icon = Icons.Filled.LocationOff,
        title = "Posizione non disponibile",
        message = "Attiva la posizione per vedere le paline vicine, oppure cerca una località.",
        iconTint = MaterialTheme.colorScheme.error,
    ) {
        TextButton(onClick = {
            context.startActivity(
                Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
        }) { Text("Impostazioni") }
    }
}
