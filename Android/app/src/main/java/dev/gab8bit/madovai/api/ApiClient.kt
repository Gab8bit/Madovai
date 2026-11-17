package dev.gab8bit.madovai.api

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import org.json.JSONObject
import java.io.IOException
import java.io.InterruptedIOException
import java.net.SocketTimeoutException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * A failed backend call, with a message that can be shown to the user as is: the backend's
 * own errors are already Italian (`{"error": "…"}`), transport failures get Italian text here.
 */
class ApiException(val kind: Kind, override val message: String, val status: Int? = null) : Exception(message) {
    enum class Kind {
        /** No connection, DNS failure, host unreachable. */
        OFFLINE,
        /** The request didn't complete in time. */
        TIMEOUT,
        /** 503: the backend is still building its static data. */
        NOT_READY,
        /** 429: more than 300 requests per minute from this IP. */
        RATE_LIMITED,
        /** 400/404: missing parameter, unknown line/stop. */
        BAD_REQUEST,
        /** 502 and any other non-2xx status. */
        SERVER,
        /** The body wasn't the JSON we expected. */
        DECODING,
    }

    /** Worth an automatic retry (as opposed to a request that will keep failing the same way). */
    val isTransient: Boolean get() = kind != Kind.BAD_REQUEST && kind != Kind.DECODING

    companion object {
        fun offline() = ApiException(Kind.OFFLINE, "Connessione assente o server non raggiungibile.")
        fun timeout() = ApiException(Kind.TIMEOUT, "Il server non risponde. Riprova tra qualche secondo.")
        fun decoding() = ApiException(Kind.DECODING, "Risposta del server non valida.")

        /** Maps an HTTP error status (+ the backend's `{"error"}` body, when there is one) to an exception. */
        fun fromStatus(status: Int, body: String?): ApiException {
            val serverMessage = body?.let { runCatching { JSONObject(it) }.getOrNull() }
                ?.let { o -> if (o.isNull("error")) null else o.optString("error").trim().takeIf { it.isNotEmpty() } }
            return when (status) {
                503 -> ApiException(Kind.NOT_READY, serverMessage ?: "Il server sta ancora preparando i dati. Riprova tra un minuto.", status)
                429 -> ApiException(Kind.RATE_LIMITED, serverMessage ?: "Troppe richieste. Riprova tra qualche secondo.", status)
                400, 404 -> ApiException(Kind.BAD_REQUEST, serverMessage ?: "Richiesta non valida ($status).", status)
                502 -> ApiException(Kind.SERVER, serverMessage ?: "La fonte dei dati non risponde. Riprova tra qualche secondo.", status)
                else -> ApiException(Kind.SERVER, serverMessage ?: "Errore del server ($status).", status)
            }
        }
    }
}

/** The text to show for any error coming out of the API layer. */
val Throwable.userMessage: String get() = (this as? ApiException)?.message ?: ApiException.offline().message

/**
 * Thin JSON-over-HTTPS client for the Madovai backend. The whole exchange — body read
 * included — runs on Dispatchers.IO (reading a body is network I/O: doing it on the main
 * thread was a real `NetworkOnMainThreadException` in 1.0.0), parsing on Dispatchers.Default.
 * Cancelling the calling coroutine cancels the HTTP call.
 */
class ApiClient(
    private val baseUrl: HttpUrl,
    private val healthUrl: HttpUrl,
    private val http: OkHttpClient,
    private val userAgent: String,
) {
    constructor(baseUrl: String, healthUrl: String, http: OkHttpClient, userAgent: String) :
        this(baseUrl.trimEnd('/').toHttpUrl(), healthUrl.toHttpUrl(), http, userAgent)

    /**
     * `{base}/{path}?{query}`. Null/blank values are omitted; values are percent-encoded by
     * OkHttp (`encodeURIComponent` semantics for "#", "&", "+": Atac trip ids contain "#").
     */
    fun url(path: String, query: Map<String, String?> = emptyMap()): HttpUrl {
        val builder = baseUrl.newBuilder()
        path.split('/').filter { it.isNotEmpty() }.forEach { builder.addPathSegment(it) }
        query.entries.sortedBy { it.key }.forEach { (k, v) -> if (!v.isNullOrBlank()) builder.addQueryParameter(k, v) }
        return builder.build()
    }

    suspend fun <T> get(path: String, query: Map<String, String?> = emptyMap(), parse: (String) -> T): T =
        fetch(url(path, query), parse)

    suspend fun <T> getHealth(parse: (String) -> T): T = fetch(healthUrl, parse)

    private suspend fun <T> fetch(url: HttpUrl, parse: (String) -> T): T {
        val request = Request.Builder().url(url).header("Accept", "application/json").header("User-Agent", userAgent).build()
        val (code, body) = withContext(Dispatchers.IO) {
            val response = try {
                http.newCall(request).await()
            } catch (e: SocketTimeoutException) {
                throw ApiException.timeout()
            } catch (e: InterruptedIOException) {
                // OkHttp's callTimeout surfaces as a plain InterruptedIOException("timeout").
                if (e.message == "timeout") throw ApiException.timeout() else throw ApiException.offline()
            } catch (e: IOException) {
                throw ApiException.offline()
            }
            response.use { r ->
                val text = try {
                    r.body?.string()
                } catch (e: SocketTimeoutException) {
                    throw ApiException.timeout()
                } catch (e: IOException) {
                    throw ApiException.offline()
                }
                r.code to text
            }
        }
        if (code !in 200..299) throw ApiException.fromStatus(code, body)
        val text = body ?: throw ApiException.decoding()
        return withContext(Dispatchers.Default) {
            try {
                parse(text)
            } catch (e: ApiException) {
                throw e
            } catch (e: Exception) {
                throw ApiException.decoding()
            }
        }
    }
}

/** Suspends on an OkHttp call; cancelling the coroutine cancels the call. */
private suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
    enqueue(object : Callback {
        override fun onResponse(call: Call, response: Response) = cont.resume(response) { _, value, _ -> value.close() }
        override fun onFailure(call: Call, e: IOException) {
            if (!cont.isCancelled) cont.resumeWithException(e)
        }
    })
    cont.invokeOnCancellation { runCatching { cancel() } }
}
