package dev.gab8bit.madovai.ui.reminders

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.DirectionsBus
import androidx.compose.material.icons.filled.Train
import androidx.compose.material.icons.outlined.AccessAlarm
import androidx.compose.material.icons.outlined.Notifications
import androidx.compose.material.icons.outlined.NotificationsActive
import androidx.compose.material.icons.outlined.NotificationsOff
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ElevatedCard
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import dev.gab8bit.madovai.AppContainer
import dev.gab8bit.madovai.model.Reminder
import dev.gab8bit.madovai.model.ReminderSource
import dev.gab8bit.madovai.ui.common.EmptyState

/** Where the app stands with notifications (drives the card at the top of the tab). */
enum class NotificationAccess { GRANTED, NOT_ASKED, ASK_AGAIN, BLOCKED }

private const val PREFS = "permissions"
private const val KEY_ASKED = "postNotificationsAsked"

fun Context.findActivity(): Activity? {
    var c: Context? = this
    while (c is ContextWrapper) {
        if (c is Activity) return c
        c = c.baseContext
    }
    return null
}

fun notificationAccess(context: Context, container: AppContainer): NotificationAccess {
    if (container.reminderNotifier.canNotify()) return NotificationAccess.GRANTED
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
        ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
    ) {
        // Permission granted (or not needed) but notifications switched off in Settings.
        return NotificationAccess.BLOCKED
    }
    val asked = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_ASKED, false)
    if (!asked) return NotificationAccess.NOT_ASKED
    val activity = context.findActivity() ?: return NotificationAccess.BLOCKED
    // After a denial Android lets us ask once more with a rationale; after the second one only Settings can help.
    return if (ActivityCompat.shouldShowRequestPermissionRationale(activity, Manifest.permission.POST_NOTIFICATIONS)) NotificationAccess.ASK_AGAIN
    else NotificationAccess.BLOCKED
}

fun openNotificationSettings(context: Context) {
    val intent = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
    runCatching { context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
}

fun openExactAlarmSettings(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return
    runCatching {
        context.startActivity(
            Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.fromParts("package", context.packageName, null)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
    }
}

/** The "Promemoria" tab: list, tap to edit, swipe or the form's button to delete, switch to pause. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RemindersScreen(container: AppContainer) {
    val context = LocalContext.current
    val reminders by container.reminderStore.reminders.collectAsState()
    var editing by remember { mutableStateOf<Reminder?>(null) }
    var creating by remember { mutableStateOf(false) }
    var note by remember { mutableStateOf<String?>(null) }

    // Re-read permission / exact-alarm access every time the screen comes back (e.g. from Settings).
    var refresh by remember { mutableIntStateOf(0) }
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_RESUME) refresh++ }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }
    val access = remember(refresh, reminders) { notificationAccess(context, container) }
    val exact = remember(refresh) { container.reminderScheduler.canScheduleExactAlarms() }
    // Exact-alarm access may have just been granted: re-arm with exact alarms.
    LaunchedEffect(exact) { container.reminderScheduler.rescheduleAll(reminders) }

    val permissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY_ASKED, true).apply()
        refresh++
        if (granted) container.reminderScheduler.rescheduleAll(container.reminderStore.reminders.value)
    }
    fun requestNotifications() {
        when (notificationAccess(context, container)) {
            NotificationAccess.GRANTED -> Unit
            NotificationAccess.BLOCKED -> openNotificationSettings(context)
            else -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) permissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    Scaffold(
        contentWindowInsets = WindowInsets(0),
        topBar = {
            TopAppBar(
                title = { Text("Promemoria") },
                actions = { IconButton(onClick = { creating = true }) { Icon(Icons.Filled.Add, "Nuovo promemoria") } },
            )
        },
    ) { padding ->
        LazyColumn(
            Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            item {
                NotificationsCard(
                    access = access,
                    hasReminders = reminders.isNotEmpty(),
                    note = note,
                    onEnable = ::requestNotifications,
                    onTest = { note = if (container.reminderNotifier.notifyTest()) "Notifica di prova inviata." else "Notifica non inviata: controlla le impostazioni delle notifiche." },
                )
            }
            if (!exact && reminders.any { it.enabled }) item { ExactAlarmCard { openExactAlarmSettings(context) } }
            if (reminders.isEmpty()) {
                item {
                    EmptyState(
                        Icons.Outlined.Notifications,
                        "Nessun promemoria",
                        "Crea un promemoria per ricevere una notifica sul prossimo bus o treno all'orario che scegli.",
                        Modifier.padding(top = 24.dp),
                    ) {
                        FilledTonalButton(onClick = { creating = true }) { Text("Nuovo promemoria") }
                    }
                }
            } else {
                items(reminders, key = { it.id }) { reminder ->
                    ReminderRow(
                        reminder = reminder,
                        onClick = { editing = reminder },
                        onToggle = { container.reminderStore.setEnabled(reminder.id, it) },
                        onDelete = { container.reminderStore.delete(reminder.id) },
                    )
                }
                item {
                    Text(
                        "All'orario scelto il telefono chiede al server Madovai il prossimo passaggio e ti avvisa con una notifica. " +
                            "Se il controllo non riesce (niente rete, nessun dato) riprova ogni 2 minuti per un massimo di 15 volte, senza avvisarti. " +
                            "Il risparmio energetico di alcuni telefoni può ritardare o bloccare i promemoria: se succede, escludi Madovai dall'ottimizzazione della batteria.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(horizontal = 4.dp, vertical = 8.dp),
                    )
                }
            }
        }
    }

    val formTarget = editing
    if (creating || formTarget != null) {
        ReminderForm(
            container = container,
            editing = formTarget,
            onDismiss = {
                creating = false
                editing = null
            },
            onSaved = {
                creating = false
                editing = null
                // Asked right after the first save (not at launch), like iOS and the web app.
                if (notificationAccess(context, container) == NotificationAccess.NOT_ASKED) requestNotifications()
            },
        )
    }
}

@Composable
private fun NotificationsCard(access: NotificationAccess, hasReminders: Boolean, note: String?, onEnable: () -> Unit, onTest: () -> Unit) {
    val (icon, text) = when (access) {
        NotificationAccess.GRANTED -> Icons.Outlined.NotificationsActive to "Notifiche attive."
        NotificationAccess.NOT_ASKED -> Icons.Outlined.Notifications to "Attiva le notifiche per ricevere i promemoria all'orario scelto."
        NotificationAccess.ASK_AGAIN -> Icons.Outlined.NotificationsOff to
            "Senza il permesso per le notifiche i promemoria non possono avvisarti. Madovai le usa solo per i promemoria che crei tu."
        NotificationAccess.BLOCKED -> Icons.Outlined.NotificationsOff to
            "Le notifiche sono disattivate per Madovai: i promemoria non potranno avvisarti. Abilitale dalle impostazioni."
    }
    val warn = access != NotificationAccess.GRANTED && hasReminders
    Card(colors = CardDefaults.cardColors(containerColor = if (warn) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.surfaceContainerHigh)) {
        Column(Modifier.padding(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(icon, null, tint = if (warn) MaterialTheme.colorScheme.onErrorContainer else MaterialTheme.colorScheme.primary)
                Spacer(Modifier.width(12.dp))
                Text(text, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                Spacer(Modifier.width(8.dp))
                when (access) {
                    NotificationAccess.GRANTED -> OutlinedButton(onClick = onTest) { Text("Prova") }
                    NotificationAccess.BLOCKED -> TextButton(onClick = onEnable) { Text("Impostazioni") }
                    else -> FilledTonalButton(onClick = onEnable) { Text("Attiva") }
                }
            }
            if (note != null) Text(note, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 6.dp))
        }
    }
}

@Composable
private fun ExactAlarmCard(onOpenSettings: () -> Unit) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerHigh)) {
        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Outlined.AccessAlarm, null, tint = MaterialTheme.colorScheme.primary)
            Spacer(Modifier.width(12.dp))
            Text(
                "Orario approssimativo: senza il permesso \"Sveglie e promemoria\" Android può ritardare il controllo di qualche minuto.",
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.weight(1f),
            )
            Spacer(Modifier.width(8.dp))
            TextButton(onClick = onOpenSettings) { Text("Consenti") }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ReminderRow(reminder: Reminder, onClick: () -> Unit, onToggle: (Boolean) -> Unit, onDelete: () -> Unit) {
    val dismissState = rememberSwipeToDismissBoxState(
        confirmValueChange = { value ->
            if (value == SwipeToDismissBoxValue.EndToStart) onDelete()
            value == SwipeToDismissBoxValue.EndToStart
        },
    )
    SwipeToDismissBox(
        state = dismissState,
        enableDismissFromStartToEnd = false,
        backgroundContent = {
            Box(
                Modifier.fillMaxSize().background(MaterialTheme.colorScheme.error, CardDefaults.elevatedShape).padding(horizontal = 20.dp),
                contentAlignment = Alignment.CenterEnd,
            ) { Text("Elimina", color = MaterialTheme.colorScheme.onError, fontWeight = FontWeight.SemiBold) }
        },
    ) {
        ElevatedCard(modifier = Modifier.fillMaxWidth().clickable(onClick = onClick)) {
            ListItem(
                colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                leadingContent = {
                    Icon(if (reminder.source.isTrain) Icons.Filled.Train else Icons.Filled.DirectionsBus, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                },
                headlineContent = { Text(reminder.stopName) },
                supportingContent = {
                    Column {
                        (reminder.source as? ReminderSource.CotralTrain)?.let { Text(it.route.directionLabel, style = MaterialTheme.typography.labelMedium) }
                        Text("${reminder.weekdaysLabel} · ${reminder.timeLabel}", style = MaterialTheme.typography.labelMedium)
                    }
                },
                trailingContent = { Switch(checked = reminder.enabled, onCheckedChange = onToggle) },
            )
        }
    }
}
