# R8 rules for the minified release build (isMinifyEnabled = true, isShrinkResources = true).
#
# JSON from the Madovai backend is parsed by hand with org.json (part of the Android
# framework itself, see api/Json.kt): no reflection, no generated adapters, so the app's
# own classes need no keep rules. OkHttp ships its own consumer rules inside its jar.

# osmdroid does tile-provider / configuration reflection and has no consumer rules of its own.
-keep class org.osmdroid.** { *; }
-dontwarn org.osmdroid.**
