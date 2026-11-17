package dev.gab8bit.madovai.live

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Runs [action] now and then every [intervalMs], but only while [foreground] is true (a
 * backgrounded app shouldn't hammer the backend or the battery), refreshing immediately
 * when the app comes back. Runs never overlap: the next wait starts after the action
 * returns.
 *
 * [refreshNow] never cancels a run already in flight — that was a real bug on iOS (the
 * "app became active" refresh cancelled the very first vehicle fetch at launch and left
 * the map empty for a whole interval). A refresh requested mid-run is queued and runs as
 * soon as the current one ends.
 */
class Poller(
    private val scope: CoroutineScope,
    private val intervalMs: Long,
    private val foreground: StateFlow<Boolean>,
    private val action: suspend () -> Unit,
) {
    private var loop: Job? = null
    private var watcher: Job? = null
    /** Conflated: any number of refresh requests while running/waiting collapse into one. */
    private val trigger = Channel<Unit>(Channel.CONFLATED)

    val isActive: Boolean get() = loop?.isActive == true

    fun start() {
        if (loop?.isActive == true) return
        loop = scope.launch {
            while (true) {
                foreground.first { it }
                // We're about to run anyway: a refresh requested before this point is satisfied by this run.
                trigger.tryReceive()
                try {
                    action()
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    // Each service records its own errors; the loop must survive anything.
                }
                // Wait for the interval, or less if a refresh was requested (also while the action ran).
                withTimeoutOrNull(intervalMs) { trigger.receive() }
            }
        }
        watcher = scope.launch {
            var wasForeground = foreground.value
            foreground.collect { now ->
                if (now && !wasForeground) refreshNow()
                wasForeground = now
            }
        }
    }

    fun stop() {
        loop?.cancel()
        watcher?.cancel()
        loop = null
        watcher = null
        trigger.tryReceive()
    }

    fun refreshNow() {
        if (loop?.isActive == true) trigger.trySend(Unit)
    }
}
