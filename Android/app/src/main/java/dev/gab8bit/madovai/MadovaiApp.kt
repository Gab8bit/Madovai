package dev.gab8bit.madovai

import android.app.Application
import org.osmdroid.config.Configuration
import java.io.File

class MadovaiApp : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        // osmdroid: identify ourselves per the OSM tile usage policy, and keep the tile
        // cache inside app-private storage (no storage permission needed).
        Configuration.getInstance().apply {
            load(this@MadovaiApp, getSharedPreferences("osmdroid", MODE_PRIVATE))
            userAgentValue = Config.OSM_USER_AGENT
            osmdroidBasePath = File(cacheDir, "osmdroid")
            osmdroidTileCache = File(cacheDir, "osmdroid/tiles")
        }
        container = AppContainer(this)
        // 1.0.0 kept ~300 MB of extracted GTFS in filesDir: 2.0 doesn't need it any more.
        Thread { LegacyCleanup.run(filesDir) }.start()
    }
}

/**
 * Removal of the on-device GTFS cache written by 1.0.0 (`files/GTFS` for Cotral bus+rail,
 * `files/AtacGTFS` for Atac, ~300 MB extracted): 2.0 gets everything from the backend.
 * Only those two folders — the DataStore files with favorites live in `files/datastore`.
 */
object LegacyCleanup {
    private val LEGACY_DIRS = listOf("GTFS", "AtacGTFS")

    fun run(filesDir: File) {
        for (name in LEGACY_DIRS) runCatching { File(filesDir, name).takeIf { it.exists() }?.deleteRecursively() }
    }
}
