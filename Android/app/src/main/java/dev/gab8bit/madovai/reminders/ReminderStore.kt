package dev.gab8bit.madovai.reminders

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import dev.gab8bit.madovai.model.Reminder
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

private val Context.remindersDataStore: DataStore<Preferences> by preferencesDataStore(name = "reminders")
private val REMINDERS_KEY = stringPreferencesKey("dev.gab8bit.madovai.reminders")

/** Reads the persisted reminders (also used by the alarm receiver, outside the UI). */
suspend fun Context.loadReminders(): List<Reminder> =
    Reminder.listFromJson(applicationContext.remindersDataStore.data.first()[REMINDERS_KEY])

/**
 * Promemoria, purely local (Jetpack DataStore, same JSON shape as the web app's
 * localStorage). Every change re-arms the alarms through [ReminderScheduler]: there is no
 * server copy — at reminder time the phone itself asks the backend for the next departure.
 */
class ReminderStore(context: Context, private val scope: CoroutineScope, private val scheduler: ReminderScheduler) {
    private val appContext = context.applicationContext
    private val dataStore = appContext.remindersDataStore

    private val _reminders = MutableStateFlow<List<Reminder>>(emptyList())
    val reminders: StateFlow<List<Reminder>> = _reminders.asStateFlow()
    private val _loaded = MutableStateFlow(false)
    val loaded: StateFlow<Boolean> = _loaded.asStateFlow()

    init {
        scope.launch {
            _reminders.value = appContext.loadReminders()
            _loaded.value = true
            // Self-heal once per launch: alarms are lost on force-stop and some OEM "cleaners".
            scheduler.rescheduleAll(_reminders.value)
        }
    }

    fun add(reminder: Reminder) = commit(_reminders.value + reminder, changedId = reminder.id)

    fun update(reminder: Reminder) =
        commit(_reminders.value.map { if (it.id == reminder.id) reminder else it }, changedId = reminder.id)

    fun setEnabled(id: String, enabled: Boolean) =
        commit(_reminders.value.map { if (it.id == id) it.copy(enabled = enabled) else it }, changedId = id)

    fun delete(id: String) {
        scheduler.cancel(id)
        commit(_reminders.value.filterNot { it.id == id }, changedId = id)
    }

    private fun commit(next: List<Reminder>, changedId: String) {
        _reminders.value = next
        // A new or edited reminder starts fresh: no inherited retry chain, no retroactive run today.
        scheduler.clearRetryState(changedId)
        scheduler.rescheduleAll(next)
        val json = Reminder.listToJson(next)
        scope.launch { dataStore.edit { it[REMINDERS_KEY] = json } }
    }
}
