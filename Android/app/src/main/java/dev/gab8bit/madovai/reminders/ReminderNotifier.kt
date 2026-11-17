package dev.gab8bit.madovai.reminders

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import dev.gab8bit.madovai.MainActivity
import dev.gab8bit.madovai.R
import dev.gab8bit.madovai.model.Reminder
import dev.gab8bit.madovai.model.ReminderDepartureStatus
import dev.gab8bit.madovai.model.ReminderTexts

/** Posts the local notifications of Promemoria (texts identical to the web app's push, see [ReminderTexts]). */
class ReminderNotifier(context: Context) {
    private val appContext = context.applicationContext

    /** True when a notification would actually be shown (runtime permission on 13+, and not blocked in Settings). */
    fun canNotify(): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(appContext, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return false
        return NotificationManagerCompat.from(appContext).areNotificationsEnabled()
    }

    fun ensureChannel() {
        val channel = NotificationChannel(CHANNEL_ID, "Promemoria", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Il prossimo bus o treno all'orario che hai scelto"
        }
        appContext.getSystemService(NotificationManager::class.java)?.createNotificationChannel(channel)
    }

    fun notify(reminder: Reminder, status: ReminderDepartureStatus) {
        val text = ReminderTexts.content(reminder, status)
        post(reminder.id, text.title, text.body)
    }

    /** "Notifiche attive" — the local equivalent of the web app's "Prova" button. */
    fun notifyTest(): Boolean {
        val t = ReminderTexts.test
        return post("test", t.title, t.body)
    }

    private fun post(tag: String, title: String, body: String): Boolean {
        if (!canNotify()) return false
        ensureChannel()
        val open = PendingIntent.getActivity(
            appContext,
            0,
            Intent(appContext, MainActivity::class.java)
                .putExtra(MainActivity.EXTRA_TAB, MainActivity.TAB_PROMEMORIA)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(appContext, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_madovai)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        return try {
            // Same tag as the web push (the reminder id): a newer reading replaces the previous one.
            NotificationManagerCompat.from(appContext).notify(tag, NOTIFICATION_ID, notification)
            true
        } catch (e: SecurityException) {
            false
        }
    }

    companion object {
        const val CHANNEL_ID = "promemoria"
        private const val NOTIFICATION_ID = 1
    }
}
