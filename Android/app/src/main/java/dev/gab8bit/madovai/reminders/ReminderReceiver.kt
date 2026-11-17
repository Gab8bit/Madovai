package dev.gab8bit.madovai.reminders

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import dev.gab8bit.madovai.Config
import dev.gab8bit.madovai.api.MadovaiApi
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Wakes up for two reasons:
 * 1. A reminder's alarm ([ACTION_FIRE]): fetch the next departure from the backend and post
 *    the notification, then arm the next occurrence — or, if the check failed or found
 *    nothing, a retry 2 minutes later (no notification), like the backend's scheduler.
 * 2. Anything that wipes or invalidates alarms: reboot, clock or time-zone change, app
 *    update, exact-alarm access granted. All reminders are re-armed.
 *
 * The work runs in `goAsync()` with a hard budget below the ~10 s a receiver gets; an
 * alarm set with `…AndAllowWhileIdle` also briefly exempts the app from Doze's network block.
 */
class ReminderReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val app = context.applicationContext
        val pending = goAsync()
        scope.launch {
            try {
                withTimeoutOrNull(BUDGET_MS) {
                    when (intent.action) {
                        ACTION_FIRE -> fire(app, intent)
                        else -> ReminderScheduler(app).rescheduleAll(app.loadReminders())
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // Never crash in the background; the next launch re-arms everything anyway.
            } finally {
                pending.finish()
            }
        }
    }

    private suspend fun fire(app: Context, intent: Intent) {
        val id = intent.getStringExtra(EXTRA_REMINDER_ID) ?: return
        val now = System.currentTimeMillis()
        val occurrence = intent.getLongExtra(EXTRA_OCCURRENCE, now).takeIf { it > 0 } ?: now
        val attempt = intent.getIntExtra(EXTRA_ATTEMPT, 0)
        val scheduler = ReminderScheduler(app)
        val reminder = app.loadReminders().firstOrNull { it.id == id }
        if (reminder == null || !reminder.enabled) {
            scheduler.cancel(id)
            scheduler.clearRetryState(id)
            return
        }
        val notifier = ReminderNotifier(app)
        // Too late to be useful (the phone was asleep far past the time), or nobody would see
        // the notification: skip this occurrence without spending a request.
        if (now - occurrence > Config.REMINDER_CHAIN_MAX_AGE_MS || !notifier.canNotify()) {
            scheduler.scheduleNextOccurrence(reminder, maxOf(now, occurrence))
            return
        }

        val status = try {
            withTimeoutOrNull(FETCH_BUDGET_MS) { ReminderStatusFetcher(api).status(reminder, now) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            null
        }

        if (status != null) {
            notifier.notify(reminder, status)
            scheduler.scheduleNextOccurrence(reminder, maxOf(now, occurrence))
            return
        }
        val retry = ReminderScheduler.nextRetry(occurrence, attempt, System.currentTimeMillis())
        if (retry != null) scheduler.scheduleRetry(id, retry)
        else scheduler.scheduleNextOccurrence(reminder, maxOf(now, occurrence))
    }

    companion object {
        const val ACTION_FIRE = "dev.gab8bit.madovai.action.REMINDER_ALARM"
        const val EXTRA_REMINDER_ID = "reminderId"
        const val EXTRA_OCCURRENCE = "occurrence"
        const val EXTRA_ATTEMPT = "attempt"

        private const val BUDGET_MS = 9_000L
        private const val FETCH_BUDGET_MS = 8_000L

        private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default + CoroutineExceptionHandler { _, _ -> })

        /** Short timeouts: the whole check has to fit in a receiver's budget. */
        private val api: MadovaiApi by lazy { MadovaiApi.create(MadovaiApi.httpClient(Config.REMINDER_REQUEST_TIMEOUT_SECONDS / 2)) }
    }
}
