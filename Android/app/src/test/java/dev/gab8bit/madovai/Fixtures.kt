package dev.gab8bit.madovai

import java.time.ZoneId
import java.time.ZonedDateTime

/** JSON captured from the production backend (https://madovai.gab8bit.net/api/v1) on 2026-11-17. */
object Fixtures {
    fun read(name: String): String =
        requireNotNull(javaClass.classLoader?.getResource("fixtures/$name")) { "missing fixture $name" }.readText()

    /** Epoch millis of a Rome wall-clock time. */
    fun rome(year: Int, month: Int, day: Int, hour: Int, minute: Int, second: Int = 0): Long =
        ZonedDateTime.of(year, month, day, hour, minute, second, 0, ZoneId.of("Europe/Rome")).toInstant().toEpochMilli()
}
