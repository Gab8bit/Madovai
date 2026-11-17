package dev.gab8bit.madovai.ui.common

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.DirectionsBus
import androidx.compose.material.icons.filled.Subway
import androidx.compose.material.icons.filled.Train
import androidx.compose.material.icons.filled.Tram
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import dev.gab8bit.madovai.model.TransitVehicleKind
import dev.gab8bit.madovai.ui.theme.TransitColors
import kotlinx.coroutines.delay
import kotlin.math.abs

fun kindIcon(kind: TransitVehicleKind): ImageVector = when (kind) {
    TransitVehicleKind.BUS -> Icons.Filled.DirectionsBus
    TransitVehicleKind.TRAM -> Icons.Filled.Tram
    TransitVehicleKind.METRO -> Icons.Filled.Subway
    TransitVehicleKind.TRENO -> Icons.Filled.Train
}

/** Delay wording, identical thresholds to the web/iOS rows: under a minute reads as on time, never as a delay. */
object DelayFormat {
    /** null when |seconds| < 60. */
    fun secondsText(seconds: Int?): String? {
        if (seconds == null || abs(seconds) < 60) return null
        val minutes = abs(seconds) / 60
        return if (seconds > 0) "in ritardo di $minutes min" else "in anticipo di $minutes min"
    }

    fun secondsColor(seconds: Int): Color = if (seconds > 0) TransitColors.Late else TransitColors.Early

    /** ASTRAL delays are whole minutes. */
    fun minutesText(minutes: Int, capitalized: Boolean = false): String {
        val s = when {
            abs(minutes) < 1 -> "puntuale"
            minutes > 0 -> "in ritardo di $minutes min"
            else -> "in anticipo di ${abs(minutes)} min"
        }
        return if (capitalized) s.replaceFirstChar { it.uppercase() } else s
    }

    fun minutesColor(minutes: Int, neutral: Color): Color = when {
        abs(minutes) < 1 -> neutral
        minutes > 0 -> TransitColors.Late
        else -> TransitColors.Early
    }
}

fun relativeMinutesLabel(minutes: Int?, zeroLabel: String): String? = when {
    minutes == null -> null
    minutes <= 0 -> zeroLabel
    minutes == 1 -> "tra 1 min"
    else -> "tra $minutes min"
}

/** A clock that ticks every 20 s so "tra N min" labels and "upcoming" filters stay fresh between polls. */
@Composable
fun rememberMinuteTicker(): Long {
    val now by produceState(System.currentTimeMillis()) {
        while (true) {
            delay(20_000L)
            value = System.currentTimeMillis()
        }
    }
    return now
}

@Composable
fun StatusDot(color: Color, pulsing: Boolean = false, size: Int = 8) {
    if (pulsing) {
        val t = rememberInfiniteTransition(label = "pulse")
        val s by t.animateFloat(1f, 1.5f, infiniteRepeatable(tween(900), RepeatMode.Reverse), label = "scale")
        val a by t.animateFloat(1f, 0.5f, infiniteRepeatable(tween(900), RepeatMode.Reverse), label = "alpha")
        Box(Modifier.size(size.dp).scale(s).alpha(a).background(color, CircleShape))
    } else {
        Box(Modifier.size(size.dp).background(color, CircleShape))
    }
}

@Composable
fun EmptyState(icon: ImageVector, title: String, message: String?, modifier: Modifier = Modifier, action: (@Composable () -> Unit)? = null) {
    Column(
        modifier.fillMaxWidth().padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(icon, null, Modifier.size(40.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(title, style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center)
        if (message != null) {
            Text(message, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
        }
        action?.invoke()
    }
}

@Composable
fun LoadingState(message: String, modifier: Modifier = Modifier) {
    Column(
        modifier.fillMaxWidth().padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        CircularProgressIndicator()
        Text(message, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
fun InlineLoading(message: String, modifier: Modifier = Modifier) {
    Row(modifier.padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
        Spacer(Modifier.width(10.dp))
        Text(message, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** A map banner card: icon, title, message, optional actions. Error tone uses errorContainer. */
@Composable
fun BannerCard(
    icon: ImageVector,
    title: String,
    message: String?,
    modifier: Modifier = Modifier,
    error: Boolean = false,
    iconTint: Color? = null,
    actions: (@Composable () -> Unit)? = null,
) {
    val container = if (error) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.surfaceContainerHigh
    val content = if (error) MaterialTheme.colorScheme.onErrorContainer else MaterialTheme.colorScheme.onSurface
    Card(
        modifier = modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = container, contentColor = content),
        elevation = CardDefaults.cardElevation(defaultElevation = 3.dp),
    ) {
        Row(Modifier.padding(start = 12.dp, end = 4.dp, top = 10.dp, bottom = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(icon, null, tint = iconTint ?: content)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.titleSmall)
                if (!message.isNullOrBlank()) {
                    Text(message, style = MaterialTheme.typography.bodySmall, color = if (error) content else MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            actions?.invoke()
        }
    }
}

@Composable
fun ErrorBanner(
    message: String,
    onRetry: (() -> Unit)?,
    modifier: Modifier = Modifier,
    title: String = "Errore di connessione",
    icon: ImageVector = Icons.Outlined.CloudOff,
) {
    BannerCard(icon, title, message, modifier, error = true) {
        if (onRetry != null) TextButton(onClick = onRetry) { Text("Riprova") }
    }
}

/** A small floating pill ("Caricamento dati…", "Avvicina la mappa…"). */
@Composable
fun HintPill(text: String, modifier: Modifier = Modifier, spinner: Boolean = false) {
    Surface(modifier, shape = CircleShape, color = MaterialTheme.colorScheme.surfaceContainerHigh, shadowElevation = 3.dp) {
        Row(Modifier.padding(horizontal = 14.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            if (spinner) {
                CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp)
                Spacer(Modifier.width(8.dp))
            }
            Text(text, style = MaterialTheme.typography.labelLarge)
        }
    }
}

/** A small filled pill label ("Soppressa", "Prossimo treno", …). */
@Composable
fun Pill(text: String, container: Color, content: Color = Color.White) {
    Box(Modifier.background(container, CircleShape).padding(horizontal = 8.dp, vertical = 3.dp)) {
        Text(text, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold, color = content)
    }
}

/** Section title in lists ("Treni", "Fermate (12)"). */
@Composable
fun SectionTitle(title: String, modifier: Modifier = Modifier) {
    Text(title, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary, modifier = modifier.padding(top = 12.dp, bottom = 4.dp, start = 4.dp))
}

/** Informational line with an icon (SwiftUI `Label(…, systemImage: "info.circle")`). */
@Composable
fun InfoLabel(icon: ImageVector, text: String, modifier: Modifier = Modifier, tint: Color = MaterialTheme.colorScheme.onSurfaceVariant) {
    Row(modifier, verticalAlignment = Alignment.Top) {
        Icon(icon, null, Modifier.size(18.dp), tint = tint)
        Spacer(Modifier.width(8.dp))
        Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
