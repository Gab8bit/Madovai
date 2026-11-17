package dev.gab8bit.madovai.ui.sheets

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.DirectionsBus
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.Map
import androidx.compose.material.icons.outlined.Notifications
import androidx.compose.material.icons.outlined.Radar
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.TouchApp
import androidx.compose.material.icons.outlined.ZoomIn
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.gab8bit.madovai.AppContainer
import dev.gab8bit.madovai.BuildConfig
import dev.gab8bit.madovai.Config
import dev.gab8bit.madovai.api.userMessage
import dev.gab8bit.madovai.model.AstralLine
import dev.gab8bit.madovai.model.AtacArrival
import dev.gab8bit.madovai.model.AtacStop
import dev.gab8bit.madovai.model.AtacStopGroup
import dev.gab8bit.madovai.model.AtacTrip
import dev.gab8bit.madovai.model.CotralTrainRoute
import dev.gab8bit.madovai.model.RomeTime
import dev.gab8bit.madovai.model.TransitOperator
import dev.gab8bit.madovai.model.TransitVehicle
import dev.gab8bit.madovai.model.TransitVehicleKind
import dev.gab8bit.madovai.ui.SheetRoute
import dev.gab8bit.madovai.ui.common.DelayFormat
import dev.gab8bit.madovai.ui.common.EmptyState
import dev.gab8bit.madovai.ui.common.LoadingState
import dev.gab8bit.madovai.ui.common.Pill
import dev.gab8bit.madovai.ui.common.StatusDot
import dev.gab8bit.madovai.ui.common.kindIcon
import dev.gab8bit.madovai.ui.common.rememberMinuteTicker
import dev.gab8bit.madovai.ui.linee.CotralLineContent
import dev.gab8bit.madovai.ui.theme.TransitColors
import kotlinx.coroutines.CancellationException
import kotlin.math.max

/** Renders the top of the sheet stack as an M3 modal bottom sheet (with drag handle). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SheetHost(container: AppContainer) {
    val top = container.sheets.top ?: return
    key(top.key) {
        val state = rememberModalBottomSheetState(skipPartiallyExpanded = top is SheetRoute.Info || top is SheetRoute.Line)
        ModalBottomSheet(onDismissRequest = { container.sheets.pop() }, sheetState = state) {
            Box(Modifier.fillMaxWidth().heightIn(min = 320.dp)) {
                when (top) {
                    is SheetRoute.CotralPole -> PoleSheet(container, top.pole)
                    is SheetRoute.AtacStation -> AtacStationSheet(container, top.group, top.routeId)
                    is SheetRoute.Vehicle -> if (top.vehicle.transitOperator == TransitOperator.COTRAL) {
                        CotralVehicleSheet(container, top.vehicle)
                    } else {
                        AtacVehicleSheet(container, top.vehicle)
                    }
                    is SheetRoute.Line -> Column {
                        Text(top.route.title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, modifier = Modifier.padding(start = 20.dp, bottom = 8.dp))
                        CotralLineContent(container, top.route) { pole -> container.sheets.push(SheetRoute.CotralPole(pole)) }
                    }
                    SheetRoute.Info -> InfoSheet()
                }
            }
        }
    }
}

// region Atac station

/**
 * Live predictions (`atac-live`) for a station; when the selected platform has none at all,
 * a best-effort timetable estimate (`atac-schedule`, clearly labelled). [group] may hold
 * several platforms of one station (one per direction) — a chip picker switches them,
 * labelled by each platform's own direction.
 */
@Composable
fun AtacStationSheet(container: AppContainer, group: AtacStopGroup, routeId: String?) {
    val stops = group.stops
    var selectedId by rememberSaveable(group.id) { mutableStateOf(stops[0].stopId) }
    val selected: AtacStop = stops.firstOrNull { it.stopId == selectedId } ?: stops[0]
    val favoriteIds by container.favoritesStore.favoriteIds.collectAsState()
    val now = rememberMinuteTicker()

    var live by remember(selected.stopId) { mutableStateOf<List<AtacArrival>?>(null) }
    var error by remember(selected.stopId) { mutableStateOf<String?>(null) }
    var fallback by remember(selected.stopId) { mutableStateOf<List<AtacArrival>>(emptyList()) }
    var loadingFallback by remember(selected.stopId) { mutableStateOf(false) }
    var fallbackFetched by remember(selected.stopId) { mutableStateOf(false) }

    PollWhileVisible(selected.stopId, Config.TRANSITS_POLL_INTERVAL_MS) {
        val id = selected.stopId
        try {
            val list = container.api.atacLive(listOf(id))[id] ?: emptyList()
            live = list
            error = null
            if (list.isEmpty() && !fallbackFetched) {
                fallbackFetched = true
                loadingFallback = true
                fallback = try {
                    container.api.atacSchedule(id)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    emptyList()
                } finally {
                    loadingFallback = false
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = e.userMessage
            if (live == null) live = emptyList()
        }
    }

    val predictions = live
    Column(Modifier.fillMaxWidth()) {
        SheetHeader(
            title = group.name,
            subtitle = "Atac / Roma TPL · tempo reale",
            // The star reflects the selected platform (per-stop_id granularity, like iOS/web).
            isFavorite = "atac:${selected.stopId}" in favoriteIds,
            onToggleFavorite = { container.favoritesStore.toggle(selected) },
        )
        if (stops.size > 1) {
            DirectionChips(stops, selected, { s -> s.headsign?.let { "Verso $it" } ?: s.stopName }) { selectedId = it.stopId }
        }
        HorizontalDivider()
        when {
            predictions == null -> LoadingState("Carico gli arrivi…")
            predictions.isNotEmpty() -> LazyColumn(contentPadding = PaddingValues(bottom = 24.dp)) {
                items(predictions, key = { it.id }) { AtacPredictionRow(it, now, scheduled = false) }
            }
            loadingFallback -> LoadingState("Cerco gli orari in programma…")
            fallback.isNotEmpty() -> LazyColumn(contentPadding = PaddingValues(bottom = 24.dp)) {
                item {
                    Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Outlined.Info, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                        Spacer(Modifier.width(8.dp))
                        Text(
                            "Nessun mezzo in tempo reale al momento: questi sono orari stimati da programmazione.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                items(fallback, key = { "s" + it.id }) { AtacPredictionRow(it, now, scheduled = true) }
            }
            error != null -> EmptyState(Icons.Outlined.CloudOff, "Errore", error)
            else -> EmptyState(Icons.Outlined.Schedule, "Nessun transito in tempo reale", "Questa fermata potrebbe non avere corse attive in questo momento.")
        }
    }
}

@Composable
private fun AtacPredictionRow(p: AtacArrival, now: Long, scheduled: Boolean) {
    val neutral = MaterialTheme.colorScheme.onSurfaceVariant
    val minutes = p.minutesFromNow(now)
    Row(
        Modifier.fillMaxWidth().alpha(if (p.cancelled) 0.6f else 1f).padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.width(72.dp)) {
            Text(p.timeLabel, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
            val rel = when {
                scheduled -> "tra ${max(minutes, 0)} min"
                minutes <= 0 -> "in arrivo"
                minutes == 1 -> "tra 1 min"
                else -> "tra $minutes min"
            }
            Text(rel, style = MaterialTheme.typography.labelMedium, color = neutral)
        }
        Column(Modifier.width(52.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Icon(kindIcon(p.kind), null, Modifier.size(20.dp))
            Text(p.routeLabel, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold, maxLines = 1)
        }
        Column(Modifier.weight(1f).padding(start = 8.dp)) {
            p.headsign?.let { Text("verso $it", style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis) }
            val delay = DelayFormat.secondsText(p.delaySeconds)
            when {
                scheduled -> Text("stimato", style = MaterialTheme.typography.labelMedium, color = neutral)
                p.cancelled -> Pill("Soppressa", MaterialTheme.colorScheme.error, MaterialTheme.colorScheme.onError)
                delay != null -> Text(delay, style = MaterialTheme.typography.labelMedium, color = DelayFormat.secondsColor(p.delaySeconds ?: 0))
            }
        }
        StatusDot(if (scheduled) TransitColors.Scheduled else TransitColors.Live, pulsing = !scheduled)
    }
}

// endregion

// region Vehicles

@Composable
private fun VehicleHeader(icon: ImageVector, title: String, subtitle: String, delaySeconds: Int?) {
    Column(Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, bottom = 12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(icon, null)
            Spacer(Modifier.width(8.dp))
            Text(title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
        }
        Text(subtitle, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        DelayFormat.secondsText(delaySeconds)?.let {
            Text(it, style = MaterialTheme.typography.labelLarge, color = DelayFormat.secondsColor(delaySeconds ?: 0))
        }
    }
}

/** Full stop-by-stop schedule of the tapped Atac vehicle's current run (`atac-trip`). */
@Composable
fun AtacVehicleSheet(container: AppContainer, vehicle: TransitVehicle) {
    val fleet by container.atacFleet.vehicles.collectAsState()
    // Re-resolved on every fleet refresh rather than freezing the tapped snapshot.
    val live = fleet.firstOrNull { it.id == vehicle.id } ?: vehicle
    var trip by remember(vehicle.tripId) { mutableStateOf<AtacTrip?>(null) }
    var loaded by remember(vehicle.tripId) { mutableStateOf(false) }
    val now = rememberMinuteTicker()

    PollWhileVisible(vehicle.tripId, Config.ATAC_TRIP_POLL_INTERVAL_MS) {
        val tripId = vehicle.tripId
        if (tripId == null) {
            loaded = true
            return@PollWhileVisible
        }
        try {
            trip = container.api.atacTrip(tripId)
        } finally {
            loaded = true
        }
    }

    val headsign = trip?.headsign ?: live.headsign
    val line = live.lineLabel
    val stops = trip?.stops ?: emptyList()
    Column(Modifier.fillMaxWidth()) {
        VehicleHeader(kindIcon(live.kind), if (headsign != null) "Linea $line verso $headsign" else "Linea $line", "${live.transitOperator.label} · tempo reale", null)
        HorizontalDivider()
        when {
            !loaded -> LoadingState("Carico l'orario della corsa…")
            stops.isEmpty() -> EmptyState(Icons.Outlined.Schedule, "Orario non disponibile", "Non ho ancora un aggiornamento in tempo reale per questa corsa.")
            else -> {
                val listState = rememberLazyListState()
                LaunchedEffect(vehicle.tripId, stops.size) {
                    val firstUpcoming = stops.indexOfFirst { it.ts * 1000 >= System.currentTimeMillis() }
                    if (firstUpcoming > 1 && listState.firstVisibleItemIndex == 0) listState.scrollToItem(firstUpcoming - 1)
                }
                LazyColumn(state = listState, contentPadding = PaddingValues(bottom = 24.dp)) {
                    items(stops, key = { it.id }) { s ->
                        val past = s.ts * 1000 < now
                        Row(
                            Modifier.fillMaxWidth().alpha(if (past) 0.5f else 1f).padding(horizontal = 20.dp, vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Box(Modifier.size(10.dp).background(if (past) TransitColors.Scheduled else TransitColors.AtacTeal, CircleShape))
                            Spacer(Modifier.width(12.dp))
                            Column(Modifier.weight(1f)) {
                                Text(s.stopName, style = MaterialTheme.typography.titleSmall)
                                DelayFormat.secondsText(s.delaySeconds)?.let {
                                    Text(it, style = MaterialTheme.typography.labelMedium, color = DelayFormat.secondsColor(s.delaySeconds ?: 0))
                                }
                            }
                            Text(RomeTime.hhmmFromUnix(s.ts), style = MaterialTheme.typography.titleSmall, fontFamily = FontFamily.Monospace)
                        }
                    }
                }
            }
        }
    }
}

/**
 * Cotral's GPS endpoint has no per-run itinerary, so for a TRAIN this shows ASTRAL's
 * timetable for the vehicle's own direction (`astral-line`: each station's next passage),
 * honestly labelled as the line's schedule, not this specific run's. For a bus it says so.
 */
@Composable
fun CotralVehicleSheet(container: AppContainer, vehicle: TransitVehicle) {
    val trainRoute = CotralTrainRoute.fromRaw(vehicle.routeId)
    var line by remember(vehicle.routeId) { mutableStateOf<AstralLine?>(null) }
    var status by remember(vehicle.routeId) { mutableStateOf(if (trainRoute != null) "loading" else "idle") }

    PollWhileVisible(vehicle.routeId, Config.ASTRAL_LINE_POLL_INTERVAL_MS) {
        val route = trainRoute ?: return@PollWhileVisible
        try {
            line = container.api.astralLine(route.rawValue)
            status = "ok"
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (status != "ok") status = "failed"
        }
    }

    // Sorted by each station's own next passage; stations done for today go last.
    val stations = remember(line) { line?.stations?.sortedBy { it.next?.sortSeconds ?: Int.MAX_VALUE } ?: emptyList() }
    Column(Modifier.fillMaxWidth()) {
        VehicleHeader(kindIcon(vehicle.kind), "Linea ${vehicle.lineLabel}", "Cotral · posizione in tempo reale", vehicle.delaySeconds)
        HorizontalDivider()
        when {
            trainRoute == null -> EmptyState(
                Icons.Outlined.Info,
                "Itinerario non disponibile",
                "Per questo veicolo Cotral l'itinerario completo non è disponibile: Cotral espone solo linea, posizione e ritardo.",
            )
            status == "loading" -> LoadingState("Carico l'orario della linea…")
            stations.isEmpty() -> EmptyState(
                Icons.Outlined.Info,
                if (status == "failed") "Orario non disponibile" else "Itinerario del veicolo non disponibile",
                if (status == "failed") "Non è stato possibile recuperare l'orario di questa linea al momento."
                else "Non risultano corse programmate per questa linea per il resto di oggi.",
            )
            else -> LazyColumn(contentPadding = PaddingValues(bottom = 24.dp)) {
                item {
                    Column(Modifier.padding(horizontal = 20.dp, vertical = 8.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Outlined.CalendarMonth, null, Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                            Spacer(Modifier.width(6.dp))
                            Text("Orario della linea, non di questa specifica corsa", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        Text(trainRoute.directionLabel, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                items(stations, key = { it.id }) { StationNextPassageRow(it) }
            }
        }
    }
}

@Composable
private fun StationNextPassageRow(station: AstralLine.Station) {
    val neutral = MaterialTheme.colorScheme.onSurfaceVariant
    Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(station.name, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
        val next = station.next
        if (next == null) {
            Text("—", color = neutral.copy(alpha = 0.6f))
        } else {
            Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (next.isReplacementBus) {
                        Icon(Icons.Filled.DirectionsBus, "Bus sostitutivo", Modifier.size(16.dp), tint = neutral)
                        Spacer(Modifier.width(4.dp))
                    }
                    Text(next.time, style = MaterialTheme.typography.titleSmall, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.SemiBold)
                }
                val d = next.delayMinutes
                when {
                    next.isCancelled -> Pill("Soppressa", MaterialTheme.colorScheme.error, MaterialTheme.colorScheme.onError)
                    d != null -> Text(DelayFormat.minutesText(d), style = MaterialTheme.typography.labelMedium, color = DelayFormat.minutesColor(d, neutral))
                }
            }
        }
    }
}

// endregion

// region Info

@Composable
fun InfoSheet() {
    LazyColumn(Modifier.fillMaxWidth().navigationBarsPadding(), contentPadding = PaddingValues(bottom = 24.dp)) {
        item { Text("Info", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, modifier = Modifier.padding(start = 20.dp, bottom = 8.dp)) }
        item { InfoSection("Come funziona") }
        item {
            InfoRow(Icons.Outlined.Map, "Due fonti, una mappa", "Cotral copre l'extraurbano del Lazio, Atac e Roma TPL coprono Roma urbana (bus, tram, metro). Sono fonti indipendenti, mostrate insieme.")
        }
        item {
            InfoRow(Icons.Outlined.Radar, "Copertura dei veicoli in tempo reale", "Puoi vedere sulla mappa la posizione in tempo reale dei veicoli Atac e Cotral. Alcuni mezzi non hanno la geolocalizzazione attiva, quindi potrebbero non essere mostrati ma comunque calcolati nelle tabelle di marcia.")
        }
        item {
            InfoRow(Icons.Outlined.TouchApp, "Tocca un veicolo", "Filtra la mappa al solo percorso e ai mezzi di quella linea, e apre l'orario. Per Atac/Roma TPL è l'orario completo della corsa; per Cotral solo le info disponibili. Il pulsante \"Reset\" in alto riporta alla vista normale.")
        }
        item {
            InfoRow(Icons.Outlined.ZoomIn, "Fermate e linee", "Fermate, paline e percorsi compaiono quando avvicini la mappa a livello di quartiere; il pulsante con il percorso a destra li mostra o nasconde.")
        }
        item {
            InfoRow(Icons.Outlined.Notifications, "Promemoria", "All'orario scelto il telefono chiede al server il prossimo passaggio e ti avvisa con una notifica: puntuale, in ritardo o soppresso. Nessun account e nessun servizio Google.")
        }
        item { InfoSection("Colori degli orari") }
        item { LegendDotRow(TransitColors.Live, "Verde: in tempo reale (veicolo tracciato)") }
        item { LegendDotRow(TransitColors.TrackedOffline, "Giallo: corsa tracciata, veicolo non in trasmissione") }
        item { LegendDotRow(TransitColors.Scheduled, "Grigio: solo orario programmato") }
        item { InfoSection("Simboli sulla mappa") }
        item { LegendRow(TransitColors.CotralPoleBus, kindIcon(TransitVehicleKind.BUS), "Palina Cotral (bus)") }
        item { LegendRow(TransitColors.CotralPoleRail, kindIcon(TransitVehicleKind.TRENO), "Stazione Cotral (treno/Roma Lido ecc.)") }
        item { LegendRow(TransitColors.Favorite, Icons.Filled.Star, "Palina preferita") }
        item { LegendRow(TransitColors.AtacStop, null, "Fermata Atac / Roma TPL") }
        item { LegendRow(TransitColors.AtacTeal, kindIcon(TransitVehicleKind.BUS), "Bus Atac in movimento") }
        item { LegendRow(TransitColors.Metro, kindIcon(TransitVehicleKind.METRO), "Metro Atac in movimento") }
        item { LegendRow(TransitColors.Tram, kindIcon(TransitVehicleKind.TRAM), "Tram Atac in movimento") }
        item { LegendRow(TransitColors.RomaTpl, kindIcon(TransitVehicleKind.BUS), "Mezzo Roma TPL in movimento") }
        item { LegendRow(TransitColors.CotralOrange, kindIcon(TransitVehicleKind.BUS), "Veicolo Cotral in movimento") }
        item { InfoSection("Crediti") }
        item { CreditRow("Dati trasporto Roma", "Roma Servizi per la Mobilità — romamobilita.it, licenza CC-BY 3.0 Italia.") }
        item { CreditRow("Dati Cotral", "Endpoint e feed GTFS pubblici di Cotral S.p.A. Orari e ritardi dei treni: ASTRAL S.p.A.") }
        item { CreditRow("Server", "I dati arrivano dal server Madovai, che li raccoglie dalle fonti ufficiali e li aggiorna ogni pochi secondi.") }
        item { CreditRow("Mappa", "© OpenStreetMap contributors (ODbL), via osmdroid.") }
        item { CreditRow("Versione", "Madovai ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})") }
    }
}

@Composable
private fun InfoSection(title: String) {
    Text(title, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(start = 20.dp, top = 16.dp, bottom = 6.dp))
}

@Composable
private fun InfoRow(icon: ImageVector, title: String, text: String) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 6.dp)) {
        Icon(icon, null, tint = MaterialTheme.colorScheme.primary)
        Spacer(Modifier.width(12.dp))
        Column {
            Text(title, style = MaterialTheme.typography.titleSmall)
            Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun LegendRow(color: Color, icon: ImageVector?, label: String) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 5.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(24.dp).background(color, CircleShape), contentAlignment = Alignment.Center) {
            if (icon != null) Icon(icon, null, Modifier.size(14.dp), tint = Color.White)
        }
        Spacer(Modifier.width(12.dp))
        Text(label, style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun LegendDotRow(color: Color, label: String) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 5.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.width(24.dp), contentAlignment = Alignment.Center) { StatusDot(color, size = 10) }
        Spacer(Modifier.width(12.dp))
        Text(label, style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun CreditRow(title: String, text: String) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 6.dp)) {
        Text(title, style = MaterialTheme.typography.titleSmall)
        Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

// endregion
