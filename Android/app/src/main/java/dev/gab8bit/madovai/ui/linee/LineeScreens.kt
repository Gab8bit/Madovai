package dev.gab8bit.madovai.ui.linee

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ElevatedCard
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.gab8bit.madovai.AppContainer
import dev.gab8bit.madovai.Config
import dev.gab8bit.madovai.api.userMessage
import dev.gab8bit.madovai.model.AtacArrival
import dev.gab8bit.madovai.model.AtacStopGroup
import dev.gab8bit.madovai.model.LineDetail
import dev.gab8bit.madovai.model.Pole
import dev.gab8bit.madovai.model.RouteInfo
import dev.gab8bit.madovai.model.TransitVehicleKind
import dev.gab8bit.madovai.model.dedupedByName
import dev.gab8bit.madovai.model.groupedStopsByName
import dev.gab8bit.madovai.ui.SheetRoute
import dev.gab8bit.madovai.ui.common.InlineLoading
import dev.gab8bit.madovai.ui.common.StatusDot
import dev.gab8bit.madovai.ui.common.kindIcon
import dev.gab8bit.madovai.ui.common.rememberMinuteTicker
import dev.gab8bit.madovai.ui.sheets.PollWhileVisible
import dev.gab8bit.madovai.ui.theme.TransitColors
import kotlinx.coroutines.CancellationException

/**
 * Standalone line browser (no map). Only lines where browsing is meaningful: Atac/Roma TPL
 * (live fleet + stop predictions) and Cotral's rail lines. Cotral's ~4000 bus routes are
 * deliberately left out (no per-line live data; they'd dominate the list) — as on web/iOS.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LineeListScreen(container: AppContainer, onOpen: (RouteInfo) -> Unit) {
    val lines by container.linesStore.lines.collectAsState()
    var error by remember { mutableStateOf<String?>(null) }
    var attempt by remember { mutableIntStateOf(0) }
    var query by rememberSaveable { mutableStateOf("") }

    LaunchedEffect(attempt) {
        if (lines != null) return@LaunchedEffect
        error = null
        try {
            container.linesStore.load()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = e.userMessage
        }
    }

    val (trains, buses) = remember(lines, query) {
        val q = query.trim().lowercase()
        fun filt(list: List<RouteInfo>) = list
            .filter { q.isEmpty() || it.shortName.lowercase().contains(q) || it.longName.lowercase().contains(q) || it.title.lowercase().contains(q) }
            .sortedBy { it.shortName }
        val atac = lines?.atac ?: emptyList()
        filt(atac.filter { it.kind == TransitVehicleKind.METRO } + (lines?.cotralRail ?: emptyList())) to
            filt(atac.filter { it.kind == TransitVehicleKind.BUS || it.kind == TransitVehicleKind.TRAM })
    }

    Scaffold(contentWindowInsets = WindowInsets(0), topBar = { TopAppBar(title = { Text("Linee") }) }) { padding ->
        LazyColumn(
            Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            item {
                OutlinedTextField(
                    value = query,
                    onValueChange = { query = it },
                    modifier = Modifier.fillMaxWidth(),
                    placeholder = { Text("Cerca una linea") },
                    leadingIcon = { Icon(Icons.Filled.Search, null) },
                    trailingIcon = { if (query.isNotEmpty()) IconButton(onClick = { query = "" }) { Icon(Icons.Filled.Close, "Cancella") } },
                    singleLine = true,
                    shape = MaterialTheme.shapes.extraLarge,
                )
            }
            if (trains.isNotEmpty()) {
                sectionHeader("Treni")
                items(trains, key = { it.id }) { r -> LineCard(r) { onOpen(r) } }
            }
            if (buses.isNotEmpty()) {
                sectionHeader("Bus")
                items(buses, key = { it.id }) { r -> LineCard(r) { onOpen(r) } }
            }
            if (trains.isEmpty() && buses.isEmpty()) {
                item {
                    when {
                        error != null -> Column(Modifier.padding(16.dp)) {
                            Text(error!!, color = MaterialTheme.colorScheme.error)
                            TextButton(onClick = { attempt++ }) { Text("Riprova") }
                        }
                        lines == null -> InlineLoading("Carico le linee…", Modifier.padding(16.dp))
                        else -> Text("Nessuna linea trovata.", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(16.dp))
                    }
                }
            }
        }
    }
}

private fun LazyListScope.sectionHeader(title: String) {
    item(key = "header-$title") {
        Text(title, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(top = 12.dp, bottom = 2.dp, start = 4.dp))
    }
}

@Composable
private fun LineCard(route: RouteInfo, onClick: () -> Unit) {
    ElevatedCard(onClick = onClick, modifier = Modifier.fillMaxWidth()) {
        ListItem(
            colors = ListItemDefaults.colors(containerColor = Color.Transparent),
            leadingContent = { Icon(kindIcon(route.iconKind), null, tint = MaterialTheme.colorScheme.primary) },
            headlineContent = { Text(route.title, fontWeight = FontWeight.SemiBold) },
            supportingContent = route.subtitleName?.let { s -> { Text(s, maxLines = 1, overflow = TextOverflow.Ellipsis) } },
            trailingContent = { Text(route.operatorLabel, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LineeDetailScreen(container: AppContainer, source: String, routeId: String, onBack: () -> Unit) {
    val lines by container.linesStore.lines.collectAsState()
    val route = remember(lines, source, routeId) {
        (if (source == "cotral") lines?.cotralRail else lines?.atac)?.firstOrNull { it.routeId == routeId }
    }
    // After process death the catalogue may not be loaded yet.
    LaunchedEffect(Unit) { container.linesStore.loadOrNull() }
    Scaffold(
        contentWindowInsets = WindowInsets(0),
        topBar = {
            TopAppBar(
                title = { Text(route?.title ?: routeId, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Indietro") } },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            when {
                route == null -> InlineLoading("Carico la linea…", Modifier.padding(16.dp))
                route.isAtac -> AtacLineContent(container, route)
                else -> CotralLineContent(container, route) { pole -> container.sheets.push(SheetRoute.CotralPole(pole)) }
            }
        }
    }
}

/** Loads `line` once per route (stops in route order + shapes), with an Italian error and retry. */
@Composable
private fun rememberLineDetail(container: AppContainer, route: RouteInfo): Triple<LineDetail?, String?, () -> Unit> {
    var detail by remember(route.id) { mutableStateOf<LineDetail?>(null) }
    var error by remember(route.id) { mutableStateOf<String?>(null) }
    var attempt by remember(route.id) { mutableIntStateOf(0) }
    LaunchedEffect(route.id, attempt) {
        error = null
        try {
            detail = container.api.line(route.source, route.routeId)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = e.userMessage
        }
    }
    return Triple(detail, error) { attempt++ }
}

/**
 * Atac/Roma TPL: live vehicles of the line (from the fleet) + one row per station in route
 * order (platforms grouped by name — never deduplicated, the sheet offers a direction
 * picker) with the line's next arrival there (`atac-live`, every 18 s).
 */
@Composable
private fun AtacLineContent(container: AppContainer, route: RouteInfo) {
    val (detail, error, retry) = rememberLineDetail(container, route)
    val fleet by container.atacFleet.vehicles.collectAsState()
    val vehicles = fleet.filter { it.routeId == route.routeId }
    val now = rememberMinuteTicker()
    val stations: List<AtacStopGroup> = remember(detail) { groupedStopsByName(detail?.stops?.map { it.asAtacStop() } ?: emptyList()) }
    var arrivals by remember(route.id) { mutableStateOf<Map<String, List<AtacArrival>>>(emptyMap()) }

    PollWhileVisible(detail, Config.ATAC_TRIP_POLL_INTERVAL_MS) {
        val ids = detail?.stops?.map { it.id } ?: return@PollWhileVisible
        if (ids.isNotEmpty()) arrivals = container.api.atacLive(ids)
    }

    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(kindIcon(route.kind), null)
                Spacer(Modifier.width(8.dp))
                Text(listOfNotNull(route.title, route.subtitleName, route.transitOperator.label).joinToString(" · "), style = MaterialTheme.typography.bodyLarge)
            }
        }
        sectionHeader("Veicoli in tempo reale (${vehicles.size})")
        if (vehicles.isEmpty()) {
            item { Text("Nessun veicolo attivo al momento su questa linea.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        } else {
            items(vehicles, key = { it.id }) { v ->
                Card(onClick = { container.sheets.push(SheetRoute.Vehicle(v)) }, modifier = Modifier.fillMaxWidth()) {
                    ListItem(
                        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                        leadingContent = { Icon(kindIcon(v.kind), null, tint = TransitColors.AtacTeal) },
                        headlineContent = { Text("Veicolo ${v.id.removePrefix("atac-")}") },
                        supportingContent = v.headsign?.let { h -> { Text("verso $h") } },
                        trailingContent = { StatusDot(TransitColors.Live, pulsing = true) },
                    )
                }
            }
        }
        sectionHeader("Fermate (${stations.size})")
        when {
            error != null && detail == null -> item {
                Column {
                    Text(error, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error)
                    TextButton(onClick = retry) { Text("Riprova") }
                }
            }
            detail == null -> item { InlineLoading("Carico le fermate…") }
            stations.isEmpty() -> item {
                Text("Nessuna fermata trovata per questa linea.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            else -> items(stations, key = { it.id }) { station ->
                // Soonest arrival of THIS line across every platform of the station.
                val next = station.stops.flatMap { arrivals[it.stopId] ?: emptyList() }
                    .filter { it.routeId == route.routeId && it.ts * 1000 - now > -120_000L }
                    .minByOrNull { it.ts }
                Card(
                    onClick = { container.sheets.push(SheetRoute.AtacStation(station, route.routeId)) },
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow),
                ) {
                    ListItem(
                        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                        headlineContent = { Text(station.name) },
                        supportingContent = if (station.stops.size > 1) {
                            val directions = station.stops.mapNotNull { it.headsign }
                            if (directions.isNotEmpty()) ({ Text(directions.joinToString(" · "), style = MaterialTheme.typography.labelSmall) }) else null
                        } else null,
                        trailingContent = {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                if (next != null) {
                                    val m = next.minutesFromNow(now)
                                    Text(if (m <= 0) "in arrivo" else "$m min", style = MaterialTheme.typography.labelLarge, color = TransitColors.Live, fontWeight = FontWeight.SemiBold)
                                } else {
                                    Text("—", color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                                Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        },
                    )
                }
            }
        }
    }
}

/**
 * Cotral rail line: stations in physical order — tapping one opens the same schedule sheet
 * as tapping its pole on the map (ASTRAL, else the timetable). A flat list can't show
 * platform distinctions, so repeated names are shown once.
 */
@Composable
fun CotralLineContent(container: AppContainer, route: RouteInfo, onStation: (Pole) -> Unit) {
    val (detail, error, retry) = rememberLineDetail(container, route)
    val stops = remember(detail) { detail?.stops?.dedupedByName { it.name } ?: emptyList() }

    LazyColumn(contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item {
            Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer)) {
                Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Outlined.Info, null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.onSecondaryContainer)
                    Spacer(Modifier.width(10.dp))
                    Text(
                        if (route.rail) "Gli orari di ogni stazione seguono Cotral in tempo reale quando disponibile, altrimenti un orario programmato — tocca una stazione per vederli."
                        else "Tocca una fermata per vedere i transiti in tempo reale.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSecondaryContainer,
                    )
                }
            }
        }
        item {
            Text(
                "${if (route.rail) "Stazioni" else "Fermate"} (${stops.size})",
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier.padding(top = 8.dp, start = 4.dp),
            )
        }
        when {
            error != null && detail == null -> item {
                Column {
                    Text(error, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error)
                    TextButton(onClick = retry) { Text("Riprova") }
                }
            }
            detail == null -> item { InlineLoading(if (route.rail) "Carico le stazioni…" else "Carico le fermate…") }
            else -> items(stops, key = { it.id }) { stop ->
                Card(
                    onClick = { onStation(Pole.fromStop(stop.id, stop.name, null, stop.lat, stop.lon, route.rail)) },
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow),
                ) {
                    ListItem(
                        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                        leadingContent = { Icon(kindIcon(if (route.rail) TransitVehicleKind.TRENO else TransitVehicleKind.BUS), null, tint = TransitColors.CotralPoleRail) },
                        headlineContent = { Text(stop.name) },
                        trailingContent = { Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null) },
                    )
                }
            }
        }
    }
}
