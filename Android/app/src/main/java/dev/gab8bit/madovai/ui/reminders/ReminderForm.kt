package dev.gab8bit.madovai.ui.reminders

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Place
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimeInput
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import dev.gab8bit.madovai.AppContainer
import dev.gab8bit.madovai.api.userMessage
import dev.gab8bit.madovai.model.CotralTrainRoute
import dev.gab8bit.madovai.model.Reminder
import dev.gab8bit.madovai.model.ReminderSource
import dev.gab8bit.madovai.model.RomeTime
import dev.gab8bit.madovai.model.SearchStop
import dev.gab8bit.madovai.model.TransitVehicleKind
import dev.gab8bit.madovai.model.Weekday
import dev.gab8bit.madovai.ui.SearchModel
import dev.gab8bit.madovai.ui.common.InfoLabel
import dev.gab8bit.madovai.ui.common.SectionTitle
import dev.gab8bit.madovai.ui.common.kindIcon
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/**
 * Create/edit a Promemoria (full-screen M3 dialog). The stop is picked with the backend
 * search; Atac metro stations are excluded (no per-stop live data in the feeds), and a
 * Cotral rail station asks for the direction (`pole` → its ASTRAL direction codes).
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun ReminderForm(container: AppContainer, editing: Reminder?, onDismiss: () -> Unit, onSaved: () -> Unit) {
    val scope = rememberCoroutineScope()
    val search = remember {
        SearchModel(container.api, scope, includeRoutes = false, stopFilter = { !(it.source == "atac" && it.metro) })
    }
    var stopName by remember { mutableStateOf(editing?.stopName ?: "") }
    var source by remember { mutableStateOf(editing?.source) }
    var trainDirections by remember {
        mutableStateOf((editing?.source as? ReminderSource.CotralTrain)?.let { CotralTrainRoute.directionsForGtfsRouteShortName(it.route.gtfsRouteShortName) } ?: emptyList())
    }
    var weekdays by remember {
        mutableStateOf(editing?.weekdays ?: setOf(Weekday.MONDAY, Weekday.TUESDAY, Weekday.WEDNESDAY, Weekday.THURSDAY, Weekday.FRIDAY))
    }
    val nowRome = remember { RomeTime.now() }
    val time = rememberTimePickerState(initialHour = editing?.hour ?: nowRome.hour, initialMinute = editing?.minute ?: nowRome.minute, is24Hour = true)
    var resolving by remember { mutableStateOf(false) }
    var stationError by remember { mutableStateOf<String?>(null) }

    val canSave = source != null && weekdays.isNotEmpty() && !resolving && stopName.isNotBlank()

    fun select(stop: SearchStop) {
        stopName = stop.name
        stationError = null
        search.clear()
        when {
            stop.isCotral && stop.rail -> {
                resolving = true
                scope.launch {
                    try {
                        val routes = container.api.pole(stop.stopId).trainRoutes.mapNotNull { CotralTrainRoute.fromRaw(it) }
                        if (routes.isEmpty()) {
                            stationError = "Nessuna linea ferroviaria trovata per questa stazione."
                            stopName = ""
                        } else {
                            trainDirections = routes
                            source = ReminderSource.CotralTrain(stop.name, routes.first(), stop.stopId)
                        }
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        stationError = e.userMessage
                        stopName = ""
                    } finally {
                        resolving = false
                    }
                }
            }
            stop.isCotral -> {
                trainDirections = emptyList()
                source = ReminderSource.CotralBus(stop.stopId)
            }
            else -> {
                trainDirections = emptyList()
                source = ReminderSource.AtacStop(stop.stopId)
            }
        }
    }

    fun save() {
        val s = source ?: return
        val reminder = Reminder(
            id = editing?.id ?: java.util.UUID.randomUUID().toString(),
            stopName = stopName.trim(),
            weekdays = weekdays,
            hour = time.hour,
            minute = time.minute,
            source = s,
            enabled = editing?.enabled ?: true,
        )
        if (editing != null) container.reminderStore.update(reminder) else container.reminderStore.add(reminder)
        onSaved()
    }

    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Scaffold(
            topBar = {
                TopAppBar(
                    title = { Text(if (editing == null) "Nuovo promemoria" else "Modifica promemoria") },
                    navigationIcon = { IconButton(onClick = onDismiss) { Icon(Icons.Filled.Close, "Annulla") } },
                    actions = { TextButton(onClick = ::save, enabled = canSave) { Text("Salva") } },
                )
            },
        ) { padding ->
            LazyColumn(
                Modifier.fillMaxSize().padding(padding).imePadding(),
                contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 32.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                item { SectionTitle("Fermata") }
                if (source != null || resolving) {
                    item {
                        Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(stopName, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
                            if (resolving) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                            TextButton(onClick = {
                                source = null
                                stopName = ""
                                trainDirections = emptyList()
                                stationError = null
                            }) { Text("Cambia") }
                        }
                    }
                } else {
                    item { StopSearchField(search) }
                    stationError?.let { msg -> item { InfoLabel(Icons.Outlined.ErrorOutline, msg, tint = MaterialTheme.colorScheme.error) } }
                    item { StopSearchStatus(search) }
                    item { StopResults(search, ::select) }
                }

                val train = source as? ReminderSource.CotralTrain
                if (train != null && trainDirections.size > 1) {
                    item { SectionTitle("Direzione") }
                    items(trainDirections, key = { it.rawValue }) { route ->
                        Row(
                            Modifier.fillMaxWidth()
                                .selectable(selected = route == train.route, role = Role.RadioButton) { source = train.copy(route = route) }
                                .padding(vertical = 4.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            RadioButton(selected = route == train.route, onClick = null)
                            Spacer(Modifier.width(8.dp))
                            Text(route.directionLabel, style = MaterialTheme.typography.bodyLarge)
                        }
                    }
                }

                item { SectionTitle("Giorni") }
                item {
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Weekday.mondayFirst.forEach { day ->
                            val on = day in weekdays
                            FilterChip(selected = on, onClick = { weekdays = if (on) weekdays - day else weekdays + day }, label = { Text(day.shortLabel) })
                        }
                    }
                }

                item { SectionTitle("Orario (ora di Roma)") }
                item { TimeInput(state = time) }

                item {
                    InfoLabel(
                        Icons.Outlined.Info,
                        "Riceverai una notifica all'orario scelto con il prossimo passaggio e il suo stato (puntuale, in ritardo o soppresso). " +
                            "Il controllo avviene sul telefono: non serve tenere aperta l'app, ma servono le notifiche attive e una connessione a Internet.",
                        Modifier.padding(top = 8.dp),
                    )
                }

                if (editing != null) {
                    item {
                        OutlinedButton(
                            onClick = {
                                container.reminderStore.delete(editing.id)
                                onDismiss()
                            },
                            modifier = Modifier.fillMaxWidth().padding(top = 16.dp),
                        ) { Text("Elimina promemoria", color = MaterialTheme.colorScheme.error) }
                    }
                }
            }
        }
    }
}

@Composable
private fun StopSearchField(search: SearchModel) {
    val query by search.query.collectAsState()
    OutlinedTextField(
        value = query,
        onValueChange = search::onQueryChange,
        modifier = Modifier.fillMaxWidth(),
        placeholder = { Text("Cerca una fermata…") },
        leadingIcon = { Icon(Icons.Filled.Search, null) },
        trailingIcon = { if (query.isNotEmpty()) IconButton(onClick = search::clear) { Icon(Icons.Filled.Close, "Cancella") } },
        singleLine = true,
    )
}

@Composable
private fun StopSearchStatus(search: SearchModel) {
    val query by search.query.collectAsState()
    val searching by search.isSearching.collectAsState()
    val error by search.error.collectAsState()
    val filteredOut by search.filteredOut.collectAsState()
    val results by search.results.collectAsState()
    Column(Modifier.padding(vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (searching) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                Spacer(Modifier.width(8.dp))
                Text("Cerco…", style = MaterialTheme.typography.labelMedium)
            }
        }
        error?.let { InfoLabel(Icons.Outlined.ErrorOutline, it, tint = MaterialTheme.colorScheme.error) }
        if (filteredOut > 0) InfoLabel(Icons.Outlined.Info, "Dati in tempo reale non disponibili per la metro.")
        if (query.isNotBlank() && !searching && error == null && results.stops.isEmpty()) {
            Text("Nessuna fermata trovata.", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun StopResults(search: SearchModel, onSelect: (SearchStop) -> Unit) {
    val results by search.results.collectAsState()
    Column {
        results.stops.forEach { s ->
            ListItem(
                headlineContent = { Text(s.name) },
                supportingContent = { Text(s.subtitle) },
                leadingContent = { Icon(if (s.isCotral) kindIcon(if (s.rail) TransitVehicleKind.TRENO else TransitVehicleKind.BUS) else Icons.Filled.Place, null) },
                modifier = Modifier.clickable { onSelect(s) },
            )
        }
    }
}
