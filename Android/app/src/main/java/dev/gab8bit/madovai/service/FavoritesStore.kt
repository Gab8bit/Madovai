package dev.gab8bit.madovai.service

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import dev.gab8bit.madovai.model.AtacStop
import dev.gab8bit.madovai.model.FavoriteStop
import dev.gab8bit.madovai.model.Pole
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

private val Context.favoritesDataStore: DataStore<Preferences> by preferencesDataStore(name = "favorites")

/**
 * Favorite stops, purely local (Jetpack DataStore). ONE persisted list for both operators,
 * with namespaced ids ("cotral:" / "atac:") so colliding codes can never merge two favorites.
 *
 * Storage is exactly 1.0.0's: same DataStore file, same key, same JSON. The ids also match
 * the backend's — 1.0.0 used the raw GTFS `stop_id` for both Cotral (`codicePalina`) and
 * Atac (`stopId`), which is what every 2.0 endpoint expects — so favorites saved by 1.0.0
 * keep working after the update without any migration step (see FavoritesCodecTest).
 */
class FavoritesStore(context: Context, private val scope: CoroutineScope) {
    private val dataStore = context.applicationContext.favoritesDataStore
    private val key = stringPreferencesKey(STORAGE_KEY)

    private val _favorites = MutableStateFlow<List<FavoriteStop>>(emptyList())
    val favorites: StateFlow<List<FavoriteStop>> = _favorites.asStateFlow()
    private val _favoriteIds = MutableStateFlow<Set<String>>(emptySet())
    val favoriteIds: StateFlow<Set<String>> = _favoriteIds.asStateFlow()

    private var loaded = false
    private val pendingToggles = ArrayList<FavoriteStop>()

    init {
        scope.launch {
            val json = dataStore.data.first()[key]
            val decoded = FavoritesCodec.decode(json)
            apply(decoded)
            loaded = true
            // Toggles that happened before the initial load finished.
            val pending = pendingToggles.toList()
            pendingToggles.clear()
            pending.forEach { toggle(it) }
        }
    }

    fun isFavoritePole(code: String?): Boolean = code != null && "cotral:$code" in _favoriteIds.value
    fun isFavoriteAtacStop(stopId: String): Boolean = "atac:$stopId" in _favoriteIds.value

    fun toggle(pole: Pole) {
        if (pole.code == null) return
        toggle(FavoriteStop.Cotral(pole.copy(codicePalina = pole.code)))
    }

    /** A favorite Atac platform is stored without the per-line headsign (it depends on how the station was opened). */
    fun toggle(stop: AtacStop) = toggle(FavoriteStop.Atac(stop.copy(headsign = null)))

    private fun toggle(item: FavoriteStop) {
        if (!loaded) {
            pendingToggles.add(item)
            return
        }
        val ids = _favoriteIds.value
        if (item.id in ids) {
            _favoriteIds.value = ids - item.id
            _favorites.value = _favorites.value.filterNot { it.id == item.id }
        } else {
            _favoriteIds.value = ids + item.id
            _favorites.value = _favorites.value + item
        }
        persist()
    }

    private fun apply(items: List<FavoriteStop>) {
        _favorites.value = items
        _favoriteIds.value = items.mapTo(LinkedHashSet()) { it.id }
    }

    private fun persist() {
        val snapshot = FavoritesCodec.encode(_favorites.value)
        scope.launch { dataStore.edit { it[key] = snapshot } }
    }

    companion object {
        const val STORAGE_KEY = "dev.gab8bit.madovai.favoritePoles"
    }
}

/** The persisted JSON (unchanged since 1.0.0). Pure, for tests. */
object FavoritesCodec {
    fun encode(items: List<FavoriteStop>): String {
        val array = JSONArray()
        for (item in items) {
            val o = JSONObject()
            when (item) {
                is FavoriteStop.Cotral -> o.put("type", "cotral").put("pole", poleToJson(item.pole))
                is FavoriteStop.Atac -> o.put("type", "atac").put(
                    "stop",
                    JSONObject().put("stopId", item.stop.stopId).put("stopName", item.stop.stopName)
                        .put("lat", item.stop.lat).put("lon", item.stop.lon),
                )
            }
            array.put(o)
        }
        return array.toString()
    }

    /** Tolerant: unknown/garbled entries are skipped, duplicates collapse to the first occurrence. */
    fun decode(json: String?): List<FavoriteStop> {
        if (json.isNullOrBlank()) return emptyList()
        val items = runCatching {
            val array = JSONArray(json)
            (0 until array.length()).mapNotNull { i ->
                val o = array.optJSONObject(i) ?: return@mapNotNull null
                when (o.optString("type")) {
                    "cotral" -> o.optJSONObject("pole")?.let(::poleFromJson)?.takeIf { it.code != null }?.let { FavoriteStop.Cotral(it) }
                    "atac" -> o.optJSONObject("stop")?.let { s ->
                        val id = str(s, "stopId")?.trim()
                        if (id.isNullOrEmpty()) null
                        else FavoriteStop.Atac(AtacStop(id, str(s, "stopName") ?: id, s.optDouble("lat", 0.0), s.optDouble("lon", 0.0)))
                    }
                    else -> null
                }
            }
        }.getOrDefault(emptyList())
        val seen = HashSet<String>()
        return items.filter { seen.add(it.id) }
    }

    private fun str(o: JSONObject, k: String): String? = if (o.isNull(k)) null else o.optString(k)

    private fun poleToJson(p: Pole): JSONObject = JSONObject().apply {
        p.codicePalina?.let { put("codicePalina", it) }
        p.codiceStop?.let { put("codiceStop", it) }
        p.nomePalina?.let { put("nomePalina", it) }
        p.nomeStop?.let { put("nomeStop", it) }
        p.localita?.let { put("localita", it) }
        p.comune?.let { put("comune", it) }
        p.coordX?.let { put("coordX", it) }
        p.coordY?.let { put("coordY", it) }
        put("isTreno", p.isTreno)
    }

    private fun poleFromJson(o: JSONObject): Pole {
        fun dbl(k: String): Double? = if (o.isNull(k)) null else o.optDouble(k).takeIf { !it.isNaN() }
        return Pole(
            codicePalina = str(o, "codicePalina")?.trim()?.takeIf { it.isNotEmpty() },
            codiceStop = str(o, "codiceStop")?.trim()?.takeIf { it.isNotEmpty() },
            nomePalina = str(o, "nomePalina"),
            nomeStop = str(o, "nomeStop"),
            localita = str(o, "localita"),
            comune = str(o, "comune"),
            coordX = dbl("coordX"),
            coordY = dbl("coordY"),
            isTreno = o.optBoolean("isTreno", false),
        )
    }
}
