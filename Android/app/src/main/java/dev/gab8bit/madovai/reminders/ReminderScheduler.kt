package dev.gab8bit.madovai.reminders

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import dev.gab8bit.madovai.Config
import dev.gab8bit.madovai.model.Reminder
import org.json.JSONObject

/**
 * Arms one AlarmManager alarm per enabled reminder (each its own PendingIntent, told apart by
 * a `madovai-reminder://<id>` data URI). When it fires, [ReminderReceiver] asks the backend
 * for the next departure and posts the notification.
 *
 * - Exact: `setExactAndAllowWhileIdle` when the app may schedule exact alarms (always
 *   below Android 12; on 12+ only with the "Sveglie e promemoria" special access, which
 *   Android 14+ no longer grants by default). The app deliberately does NOT declare
 *   `USE_EXACT_ALARM` (Play reserves it for alarm-clock/calendar apps).
 * - Otherwise `setAndAllowWhileIdle`: still fires in Doze, but the system may defer it by
 *   some minutes; the Promemoria tab explains this and links to the setting.
 *
 * Retry chains (no data / no network → retry every 2 min, max 15 times, abandoned after
 * 60 min — the backend's own rules) are persisted in [RetryState] so a reschedule (app
 * launch, edit of another reminder) doesn't drop an in-progress chain.
 */
class ReminderScheduler(context: Context) {
    private val appContext = context.applicationContext
    private val alarms = appContext.getSystemService(AlarmManager::class.java)
    private val prefs = appContext.getSharedPreferences("reminder_state", Context.MODE_PRIVATE)

    /** Persisted retry chain of one reminder: which occurrence, how many attempts so far, when the next one is due. */
    data class RetryState(val occurrenceMillis: Long, val attempt: Int, val retryAtMillis: Long) {
        fun toJson(): String = JSONObject().put("occurrence", occurrenceMillis).put("attempt", attempt).put("retryAt", retryAtMillis).toString()

        companion object {
            fun fromJson(json: String?): RetryState? = json?.let {
                runCatching { JSONObject(it).let { o -> RetryState(o.getLong("occurrence"), o.getInt("attempt"), o.getLong("retryAt")) } }.getOrNull()
            }
        }
    }

    fun canScheduleExactAlarms(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarms?.canScheduleExactAlarms() == true

    /** Re-arms every enabled reminder and cancels the disabled ones. Safe to call any time. */
    fun rescheduleAll(reminders: List<Reminder>, nowMillis: Long = System.currentTimeMillis()) {
        for (reminder in reminders) {
            if (!reminder.enabled || !reminder.isValid) {
                cancel(reminder.id)
                continue
            }
            val plan = plan(reminder, retryState(reminder.id), nowMillis)
            if (plan == null) {
                cancel(reminder.id)
                continue
            }
            if (plan.retry == null) clearRetryState(reminder.id)
            arm(reminder.id, plan.atMillis, plan.occurrenceMillis, plan.retry?.attempt ?: 0)
        }
    }

    /** Next occurrence after a run (successful or given up). */
    fun scheduleNextOccurrence(reminder: Reminder, afterMillis: Long) {
        clearRetryState(reminder.id)
        val next = reminder.nextFireMillis(afterMillis) ?: return cancel(reminder.id)
        arm(reminder.id, next, next, 0)
    }

    fun scheduleRetry(reminderId: String, state: RetryState) {
        prefs.edit().putString(stateKey(reminderId), state.toJson()).apply()
        arm(reminderId, state.retryAtMillis, state.occurrenceMillis, state.attempt)
    }

    fun cancel(reminderId: String) {
        alarms?.cancel(pendingIntent(reminderId, 0, 0, PendingIntent.FLAG_NO_CREATE) ?: return)
    }

    fun retryState(reminderId: String): RetryState? = RetryState.fromJson(prefs.getString(stateKey(reminderId), null))

    fun clearRetryState(reminderId: String) {
        prefs.edit().remove(stateKey(reminderId)).apply()
    }

    private fun arm(reminderId: String, atMillis: Long, occurrenceMillis: Long, attempt: Int) {
        val manager = alarms ?: return
        val pi = pendingIntent(reminderId, occurrenceMillis, attempt, PendingIntent.FLAG_UPDATE_CURRENT) ?: return
        try {
            if (canScheduleExactAlarms()) {
                manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atMillis, pi)
            } else {
                manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atMillis, pi)
            }
        } catch (e: SecurityException) {
            // The exact-alarm access was revoked between the check and the call.
            manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atMillis, pi)
        }
    }

    private fun pendingIntent(reminderId: String, occurrenceMillis: Long, attempt: Int, flags: Int): PendingIntent? {
        val intent = Intent(appContext, ReminderReceiver::class.java)
            .setAction(ReminderReceiver.ACTION_FIRE)
            .setData(Uri.parse("madovai-reminder://reminder/${Uri.encode(reminderId)}"))
            .putExtra(ReminderReceiver.EXTRA_REMINDER_ID, reminderId)
            .putExtra(ReminderReceiver.EXTRA_OCCURRENCE, occurrenceMillis)
            .putExtra(ReminderReceiver.EXTRA_ATTEMPT, attempt)
        return PendingIntent.getBroadcast(appContext, 0, intent, flags or PendingIntent.FLAG_IMMUTABLE)
    }

    private fun stateKey(id: String) = "retry.$id"

    data class Plan(val atMillis: Long, val occurrenceMillis: Long, val retry: RetryState?)

    companion object {
        /**
         * What to arm for a reminder right now: a still-valid pending retry, else the next
         * occurrence strictly after [nowMillis] (a missed occurrence is never run late —
         * the backend's "no retroactive execution" rule). Pure, for tests.
         */
        fun plan(reminder: Reminder, retry: RetryState?, nowMillis: Long): Plan? {
            if (retry != null && retry.retryAtMillis > nowMillis - 60_000 &&
                retry.retryAtMillis - retry.occurrenceMillis <= Config.REMINDER_CHAIN_MAX_AGE_MS &&
                retry.attempt < Config.REMINDER_MAX_RETRIES
            ) {
                return Plan(maxOf(retry.retryAtMillis, nowMillis), retry.occurrenceMillis, retry)
            }
            val next = reminder.nextFireMillis(nowMillis) ?: return null
            return Plan(next, next, null)
        }

        /** After a failed check: the retry to arm, or null when the chain is over (max attempts / max age). Pure, for tests. */
        fun nextRetry(occurrenceMillis: Long, failedAttempt: Int, nowMillis: Long): RetryState? {
            val attempt = failedAttempt + 1
            val retryAt = nowMillis + Config.REMINDER_RETRY_INTERVAL_MS
            if (attempt >= Config.REMINDER_MAX_RETRIES) return null
            if (retryAt - occurrenceMillis > Config.REMINDER_CHAIN_MAX_AGE_MS) return null
            return RetryState(occurrenceMillis, attempt, retryAt)
        }
    }
}
