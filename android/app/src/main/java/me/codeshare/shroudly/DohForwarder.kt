package me.codeshare.shroudly

import java.io.IOException
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.Socket
import java.net.URL
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.RejectedExecutionHandler
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SNIHostName
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory

/*
 * Local DNS-over-HTTPS forwarder, the Android side of electron/doh-forwarder.js.
 *
 * The engine sends its lookups to 127.0.0.1:<port> (--doh-port) as plain DNS
 * over UDP; each one goes out as an RFC 8484 POST to public resolvers, so names
 * are encrypted on the wire and cannot be forged.
 *
 * As on the desktop, no single resolver is relied on:
 *   - by address, with no name in the handshake: five operators, two or more
 *     addresses each. A filter has to know and block every address.
 *   - by name, through the engine, on addresses shared with a large part of
 *     the web (Cloudflare's front end): the name is split like any other.
 * Routes that fail rest with a growing back-off, fast ones go first, and the
 * one that last worked is remembered. A lookup races the best route alone,
 * then the next two, then three more at a time until one answers.
 *
 * Android's HttpsURLConnection speaks HTTP/1.1 only, so the resolvers that
 * accept nothing but HTTP/2 (Quad9, Mullvad) are not in this list.
 *
 * Every operator is reached by its IPv6 addresses too: on a network with
 * IPv6 only, IPv4 addresses work only through the carrier's translation
 * (464XLAT), which not every network offers. Where a family is missing, its
 * routes fail at once (the network is unreachable) and rest, like any other
 * failure.
 *
 * This app is left out of its own VPN, so these connections go straight to
 * the network. No lookup is logged or stored.
 *
 * The engine waits ENGINE_WAIT_MS for an answer and then asks plain DNS
 * instead, so a lookup is answered within that time or not at all: one that
 * waited too long in the queue is dropped, the queue itself is bounded, and
 * a race ends before the engine stops waiting.
 */

class DohRoute(
    val id: String,
    val op: String,
    /* An IPv4 or IPv6 address, without brackets. */
    val ip: String,
    /* Names the certificate may carry instead of the address. */
    val names: List<String>,
    /* Set for routes through the engine: the name sent in the handshake. */
    val sni: String? = null,
) {
    val viaEngine get() = sni != null
    val v6 get() = ip.contains(':')
    /* The address as a URL's host. */
    val urlHost get() = if (v6) "[$ip]" else ip

    /* One verifier per network: HttpsURLConnection pools connections per
     * verifier, so a new one per request would mean a new TCP and TLS
     * handshake for every lookup, and a new one once the network changed
     * (fresh) keeps the old network's connections out of the pool's reach. */
    @Volatile var verifier: HostnameVerifier = newVerifier()
        private set
    @Volatile var fails = 0
    @Volatile var restUntil = 0L
    @Volatile var ewma = 0L

    private fun newVerifier(): HostnameVerifier {
        val d = HttpsURLConnection.getDefaultHostnameVerifier()
        return HostnameVerifier { _, session -> d.verify(ip, session) || names.any { d.verify(it, session) } }
    }

    /* Another network: new connections, and the rest earned on the old one
     * forgotten (its speed is kept, a fair first guess). */
    fun fresh() {
        verifier = newVerifier()
        fails = 0
        restUntil = 0
    }

    fun succeeded(ms: Long) {
        ewma = if (ewma == 0L) ms else (ewma * 7 + ms * 3) / 10
        fails = 0
        restUntil = 0
    }

    fun failed(now: Long) {
        fails++
        restUntil = now + minOf(DohForwarder.REST_MAX_MS, DohForwarder.REST_BASE_MS shl minOf(fails - 1, 20))
    }

    override fun toString() = id
}

class DohForwarder(
    private val log: (String) -> Unit,
    preferred: String?,
    private val onPreferred: (String) -> Unit,
) {
    companion object {
        const val QUERY_TIMEOUT_MS = 2500
        const val SECOND_WAVE_MS = 250L
        const val THIRD_WAVE_MS = 900L
        const val NEXT_WAVE_MS = 650L
        const val WAVE_SIZE = 3
        const val REST_BASE_MS = 2000L
        const val REST_MAX_MS = 300000L
        const val WARM_INTERVAL_MS = 120000L
        // The engine's own wait (core/src/doh.c), and what is left of it for us:
        // a lookup still queued after STALE_MS is dropped, and a race ends by ANSWER_BY_MS.
        const val ENGINE_WAIT_MS = 4000L
        const val STALE_MS = ENGINE_WAIT_MS - 500
        const val ANSWER_BY_MS = ENGINE_WAIT_MS - 200
        // The user's own server not answering twice in a row: the built-in
        // routes answer for this long before it is asked again.
        const val CUSTOM_REST_MS = 30000L
        const val CUSTOM_TELL_MS = 10 * 60 * 1000L

        private val CF = listOf("cloudflare-dns.com", "one.one.one.one")

        fun routes() = listOf(
            DohRoute("cloudflare-1", "cloudflare", "1.1.1.1", CF),
            DohRoute("google-1", "google", "8.8.8.8", listOf("dns.google")),
            DohRoute("adguard-1", "adguard", "94.140.14.140", listOf("unfiltered.adguard-dns.com", "dns.adguard-dns.com")),
            DohRoute("opendns-1", "opendns", "208.67.222.222", listOf("doh.opendns.com", "dns.opendns.com")),
            DohRoute("dnssb-1", "dnssb", "185.222.222.222", listOf("doh.sb", "dns.sb")),
            DohRoute("cloudflare-2", "cloudflare", "1.0.0.1", CF),
            DohRoute("google-2", "google", "8.8.4.4", listOf("dns.google")),
            DohRoute("adguard-2", "adguard", "94.140.14.141", listOf("unfiltered.adguard-dns.com", "dns.adguard-dns.com")),
            DohRoute("opendns-2", "opendns", "208.67.220.220", listOf("doh.opendns.com", "dns.opendns.com")),
            DohRoute("dnssb-2", "dnssb", "45.11.45.11", listOf("doh.sb", "dns.sb")),
            DohRoute("cloudflare-3", "cloudflare", "162.159.36.1", CF),
            DohRoute("cloudflare-4", "cloudflare", "162.159.46.1", CF),
            // The same operators over IPv6, last among equals: on most
            // networks IPv4 works, and these rest after failing once where
            // IPv6 does not.
            DohRoute("cloudflare-6a", "cloudflare", "2606:4700:4700::1111", CF),
            DohRoute("google-6a", "google", "2001:4860:4860::8888", listOf("dns.google")),
            DohRoute("adguard-6a", "adguard", "2a10:50c0::1:ff", listOf("unfiltered.adguard-dns.com", "dns.adguard-dns.com")),
            DohRoute("opendns-6a", "opendns", "2620:119:35::35", listOf("doh.opendns.com", "dns.opendns.com")),
            DohRoute("cloudflare-6b", "cloudflare", "2606:4700:4700::1001", CF),
            DohRoute("google-6b", "google", "2001:4860:4860::8844", listOf("dns.google")),
            // By name, through the engine.
            DohRoute("cloudflare-front-1", "cloudflare-front", "104.16.248.249", CF, sni = "cloudflare-dns.com"),
            DohRoute("cloudflare-front-2", "cloudflare-front", "104.16.249.249", CF, sni = "cloudflare-dns.com"),
        )

        /* The order to try routes in: the remembered one, then measured speed
         * (untried counts as average), resting routes last. Then the best of
         * the other kind and the best of another operator move up to the
         * second wave: a network that blocks one kind of route usually blocks
         * all of that kind. */
        fun plan(all: List<DohRoute>, preferredId: String?, now: Long, engineReady: Boolean): List<DohRoute> {
            // The clock set back since a route failed: it rests at most the
            // longest rest from now, not until the clock catches up.
            for (r in all) if (r.restUntil > now + REST_MAX_MS) r.restUntil = now + REST_MAX_MS
            fun score(r: DohRoute) = if (r.restUntil > now) 1_000_000_000L + r.restUntil - now else if (r.ewma > 0) r.ewma else 400L
            val ordered = all.filter { !it.viaEngine || engineReady }.sortedWith { a, b ->
                val pa = a.id == preferredId && a.restUntil <= now
                val pb = b.id == preferredId && b.restUntil <= now
                when {
                    pa && !pb -> -1
                    pb && !pa -> 1
                    else -> score(a).compareTo(score(b))
                }
            }
            val awake = ordered.filter { it.restUntil <= now }
            // Everything resting: still try the three that wake soonest.
            var plan = if (awake.isNotEmpty()) awake else ordered.take(3)
            if (plan.size > 2) {
                val first = plan[0]
                val rest = plan.drop(1)
                val otherKind = rest.firstOrNull { it.viaEngine != first.viaEngine }
                val otherOp = rest.firstOrNull { it !== otherKind && it.op != first.op }
                val lead = listOfNotNull(first, otherKind, otherOp)
                plan = lead + rest.filter { it !in lead }
            }
            return plan
        }
    }

    private val all = routes()
    /* The user's own server (Settings, "DNS server", issue #34): asked alone
     * while it answers; null: the built-in routes. */
    @Volatile var custom: CustomDns? = null
        private set
    @Volatile private var preferredId: String? = preferred
    @Volatile var socksPort = 0
    /* The engine's SOCKS5 password for this session, if it takes one. */
    @Volatile var socksAuth: SocksAuth? = null
    @Volatile private var running = false
    private var sock: DatagramSocket? = null
    private val failuresInARow = AtomicInteger(0)
    @Volatile private var lastDownWarn = 0L

    // Lookups being answered, and the requests they race. Both queues are
    // bounded: when lookups come faster than they can be answered, the oldest
    // waiting one (the one the engine is most likely to have given up on) goes.
    private val lookups = pool("doh-lookup", 16, 64, ThreadPoolExecutor.DiscardOldestPolicy())
    // A full queue refuses the attempt (race() counts it as failed, not in flight).
    private val queries = pool("doh-query", 32, 128, ThreadPoolExecutor.AbortPolicy())
    private var timer: ScheduledExecutorService? = null

    private fun pool(name: String, n: Int, queue: Int, full: RejectedExecutionHandler): ThreadPoolExecutor {
        val count = AtomicInteger()
        return ThreadPoolExecutor(n, n, 30, TimeUnit.SECONDS, ArrayBlockingQueue(queue), { r ->
            Thread(r, "$name-${count.incrementAndGet()}").apply { isDaemon = true }
        }, full).apply { allowCoreThreadTimeOut(true) }
    }

    @Volatile private var serveThread: Thread? = null

    // Answers kept for their TTL (AnswerCache): an app's own lookups among them.
    val answers = AnswerCache()

    /* Binds 127.0.0.1 on `port` (0: a free one) and returns the port. */
    fun start(port: Int = 0): Int {
        val s = DatagramSocket(InetSocketAddress(InetAddress.getByName("127.0.0.1"), port))
        sock = s
        running = true
        serveThread = Thread({ serve(s) }, "doh-forwarder").apply { isDaemon = true; start() }
        if (timer == null) {
            timer = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "doh-warm").apply { isDaemon = true } }
                .also { it.scheduleWithFixedDelay({ warm() }, 0, WARM_INTERVAL_MS, TimeUnit.MILLISECONDS) }
        }
        return s.localPort
    }

    /* It still answers on its port: started, not stopped, and its thread has
     * not ended on an error of its socket. */
    val serving get() = running && serveThread?.isAlive == true

    /* After its thread ended on its own: the same port again, which the
     * engine was given. false if the port cannot be had back. */
    fun restart(port: Int): Boolean {
        if (!running) return false
        try { sock?.close() } catch (_: Exception) {}
        return try {
            start(port) == port
        } catch (e: Exception) {
            log("DoH forwarder could not take port $port back: ${e.message}")
            false
        }
    }

    /* A server of the user's own, or null for the built-in routes. Its name,
     * if it has one, is looked up through the built-in routes. strict: it
     * alone answers, with no fallback when it does not (issue #34). */
    fun setCustom(spec: DnsSpec?, strict: Boolean = false, proxy: DnsProxy? = null) {
        custom?.close()
        // The answers kept from before: the user wants this server's.
        answers.clear()
        custom = spec?.let { s ->
            CustomDns(s, { socksPort }, { socksAuth }, proxy) { name ->
                Dns.firstA(resolveRoutes(Dns.buildQuery(name, Dns.TYPE_A, (Math.random() * 65535).toInt()), System.nanoTime() / 1_000_000 + ANSWER_BY_MS))
            }.also { it.strict = strict }
        }
    }

    /* The user's server answers lookups now (set, and not resting; used
     * alone, always). */
    fun usingCustom(): Boolean { val c = custom; return c != null && (c.strict || c.restUntil <= System.currentTimeMillis()) }

    /* Used alone, it did not answer, and nothing else is asked: said at most
     * every ten minutes. */
    private fun customFailedStrict(c: CustomDns, e: Exception) {
        if (custom !== c) return
        val now = System.currentTimeMillis()
        if (now - c.toldAt < CUSTOM_TELL_MS) return
        c.toldAt = now
        val why = (if (e is java.net.ConnectException) "ECONNREFUSED" else if (e is java.net.SocketTimeoutException) "timeout" else e.message ?: e.javaClass.simpleName).take(80)
        log("Your DNS server ${CustomDns.shown(c.spec)} does not answer ($why); it is the only one used, so lookups fail until it answers")
    }

    /* It did not answer: after the second time in a row it rests, the
     * built-in routes answering meanwhile, and the log says so (at most every
     * ten minutes) rather than every lookup failing or waiting. */
    private fun customFailed(c: CustomDns, e: Exception) {
        if (custom !== c) return
        c.fails++
        if (c.fails < 2) return
        val now = System.currentTimeMillis()
        c.restUntil = now + CUSTOM_REST_MS
        if (now - c.toldAt < CUSTOM_TELL_MS) return
        c.toldAt = now
        val why = (if (e is java.net.ConnectException) "ECONNREFUSED" else if (e is java.net.SocketTimeoutException) "timeout" else e.message ?: e.javaClass.simpleName).take(80)
        log("Your DNS server ${CustomDns.shown(c.spec)} does not answer ($why); Shroudly's built-in encrypted DNS answers until it does")
    }

    private fun customAnswered(c: CustomDns) {
        if (c.toldAt != 0L) log("Your DNS server ${CustomDns.shown(c.spec)} answers again")
        c.fails = 0
        c.restUntil = 0
        c.toldAt = 0
    }

    fun stop() {
        custom?.drop()
        answers.clear()
        running = false
        timer?.shutdownNow()
        timer = null
        sock?.close()
        sock = null
        socksPort = 0
    }

    private fun serve(s: DatagramSocket) {
        val buf = ByteArray(4096)
        while (running) {
            val pkt = DatagramPacket(buf, buf.size)
            try {
                s.receive(pkt)
            } catch (e: IOException) {
                if (running) log("DoH forwarder: ${e.message}")
                if (s.isClosed) return
                continue
            } catch (e: RuntimeException) {
                log("DoH forwarder stopped: $e")
                return
            }
            if (!Dns.isQuery(pkt.data, pkt.length)) continue
            val msg = pkt.data.copyOf(pkt.length)
            val to = pkt.socketAddress
            val kept = answers.get(msg)
            if (kept != null) {
                try { s.send(DatagramPacket(kept, kept.size, to)) } catch (_: IOException) {}
                continue
            }
            val rx = System.nanoTime() / 1_000_000
            lookups.execute {
                // The engine has stopped waiting for this one.
                if (System.nanoTime() / 1_000_000 - rx > STALE_MS) return@execute
                // Only the user's server, and it did not answer: "server
                // failure" goes back, so the engine stops waiting for it (it
                // falls through to nothing else) and the app asking hears at once.
                val answer = resolve(msg, rx + ANSWER_BY_MS) ?: if (custom?.strict == true) Dns.failReply(msg) else null
                if (answer != null) {
                    answers.put(msg, answer)
                    failuresInARow.set(0)
                    try { s.send(DatagramPacket(answer, answer.size, to)) } catch (_: IOException) {}
                } else {
                    // Nothing goes back, so the engine falls through to plain DNS.
                    // Say so, rather than let it pass unnoticed.
                    val now = System.currentTimeMillis()
                    if (failuresInARow.incrementAndGet() >= 3 && now - lastDownWarn > 300000) {
                        lastDownWarn = now
                        log("Encrypted DNS is not reachable on this network; lookups are falling back to ordinary DNS.")
                    }
                }
            }
        }
    }

    /* answerBy: on the System.nanoTime() clock, in milliseconds. */
    fun resolve(msg: ByteArray, answerBy: Long = Long.MAX_VALUE): ByteArray? {
        val c = custom
        if (c != null && c.strict) {
            return try { c.query(msg).also { customAnswered(c) } } catch (e: Exception) { customFailedStrict(c, e); null }
        }
        if (c != null && c.restUntil <= System.currentTimeMillis()) {
            try {
                return c.query(msg).also { customAnswered(c) }
            } catch (e: Exception) {
                customFailed(c, e)
            }
        }
        return resolveRoutes(msg, answerBy)
    }

    /* Through the built-in routes, raced (a server failure as FailureVote says). */
    fun resolveRoutes(msg: ByteArray, answerBy: Long = Long.MAX_VALUE): ByteArray? {
        val plan = plan(all, preferredId, System.currentTimeMillis(), socksPort > 0)
        val vote = FailureVote()
        val won = race(plan, queries, answerBy = answerBy) { r -> vote.take(r, query(r, msg)) } ?: return vote.held
        if (Dns.serverFailed(won.second)) return won.second
        if (preferredId != won.first.id) {
            preferredId = won.first.id
            onPreferred(won.first.id)
        }
        return won.second
    }

    /* Another network, or the same one back after a gap: the connections
     * made before are dead without knowing it where the old network did not
     * go away at once (Wi-Fi out of range but still joined, mobile data
     * lingering), and a lookup on one waits out its whole timeout; the rests
     * earned there say nothing about here. Lookups start afresh, the
     * remembered route first, and the user's own server connects again. As
     * the desktop's (electron/doh-forwarder.js networkChanged). Moving
     * between Wi-Fi and mobile data stopped every lookup until protection was
     * turned off and on (a user's report). */
    fun networkChanged() {
        for (r in all) r.fresh()
        custom?.let { it.drop(); it.fails = 0; it.restUntil = 0 }
        failuresInARow.set(0)
        try { timer?.execute { warm() } } catch (_: RejectedExecutionException) {}
    }

    /* Which routes answer, for the log: "cloudflare-1 23ms, google-1 31ms". */
    fun summary(): String {
        val c = custom
        if (c != null && usingCustom()) return if (c.ewma > 0) "${CustomDns.shown(c.spec)} ${c.ewma}ms" else ""
        val now = System.currentTimeMillis()
        return all.filter { (!it.viaEngine || socksPort > 0) && it.ewma > 0 && it.restUntil <= now }
            .sortedBy { it.ewma }.take(3).joinToString(", ") { "${it.id} ${it.ewma}ms" }
    }

    /* Keep the best routes' connections open before anyone browses, and look
     * in on resting routes now and then. */
    private fun warm() {
        if (!running) return
        // The user's server is asked even while it rests, so one that comes
        // back is used again by itself; while it answers, nothing else needs
        // warming.
        val c = custom
        if (c != null) {
            val using = usingCustom()
            try {
                queries.execute {
                    try { c.query(Dns.buildQuery("cloudflare.com", Dns.TYPE_A, 0)); customAnswered(c) } catch (e: Exception) { if (c.strict) customFailedStrict(c, e) else customFailed(c, e) }
                }
            } catch (_: RejectedExecutionException) {}
            if (using) return
        }
        val now = System.currentTimeMillis()
        val order = plan(all, preferredId, now, socksPort > 0)
        val due = all.filter { it.restUntil > now && it.restUntil - now < WARM_INTERVAL_MS }.take(2)
        for (r in order.filter { it.restUntil <= now }.take(3) + due) {
            try {
                queries.execute { try { query(r, Dns.buildQuery("cloudflare.com", Dns.TYPE_A, 0)) } catch (_: Exception) {} }
            } catch (_: RejectedExecutionException) {
                return
            }
        }
    }

    /* One request on one route. Throws on any failure; keeps the route's record. */
    private fun query(r: DohRoute, msg: ByteArray): ByteArray {
        // How long it took, on a clock no change of the date moves.
        val t0 = System.nanoTime()
        try {
            val body = if (r.viaEngine) viaEngine(r, msg) else direct(r, msg)
            val answer = Dns.matchAnswer(msg, body) ?: throw IOException("not an answer to the query")
            r.succeeded((System.nanoTime() - t0) / 1_000_000)
            return answer
        } catch (e: Exception) {
            r.failed(System.currentTimeMillis())
            throw e
        }
    }

    private val defaultVerifier = HttpsURLConnection.getDefaultHostnameVerifier()

    /* To the resolver's address with no name in the handshake. The
     * certificate has to be the resolver's: its address, or one of its names.
     * The connection goes back to the pool for the next lookup (the body is
     * read to the end and the stream closed, without disconnect()). */
    private fun direct(r: DohRoute, msg: ByteArray): ByteArray {
        val c = URL("https://${r.urlHost}/dns-query").openConnection(Proxy.NO_PROXY) as HttpsURLConnection
        try {
            c.hostnameVerifier = r.verifier
            c.connectTimeout = QUERY_TIMEOUT_MS
            c.readTimeout = QUERY_TIMEOUT_MS
            c.requestMethod = "POST"
            c.doOutput = true
            c.useCaches = false
            c.setRequestProperty("Content-Type", "application/dns-message")
            c.setRequestProperty("Accept", "application/dns-message")
            c.setFixedLengthStreamingMode(msg.size)
            c.outputStream.use { it.write(msg) }
            val status = c.responseCode
            if (status != 200) throw IOException("HTTP $status")
            val body = c.inputStream.use { it.readBytes() }
            if (body.size < 12 || body.size > 65535) throw IOException("bad body")
            return body
        } catch (e: Exception) {
            c.disconnect()
            throw e
        }
    }

    /* Through the engine's SOCKS5 port to an address, with the name in the
     * handshake, so the engine can split it like any other. One request per
     * connection. */
    private fun viaEngine(r: DohRoute, msg: ByteArray): ByteArray {
        val port = socksPort
        if (port <= 0) throw IOException("engine not ready")
        val raw = Socket(Proxy.NO_PROXY)
        try {
            raw.connect(InetSocketAddress(InetAddress.getByName("127.0.0.1"), port), QUERY_TIMEOUT_MS)
            raw.soTimeout = QUERY_TIMEOUT_MS
            Socks5.connect(raw, r.ip, 443, socksAuth)
            val ssl = (SSLSocketFactory.getDefault() as SSLSocketFactory).createSocket(raw, r.sni, 443, true) as SSLSocket
            ssl.sslParameters = ssl.sslParameters.apply { serverNames = listOf(SNIHostName(r.sni)) }
            ssl.startHandshake()
            if (!defaultVerifier.verify(r.sni, ssl.session)) throw IOException("certificate does not belong to ${r.sni}")
            val head = "POST /dns-query HTTP/1.1\r\nHost: ${r.sni}\r\n" +
                "Content-Type: application/dns-message\r\nAccept: application/dns-message\r\n" +
                "Content-Length: ${msg.size}\r\nConnection: close\r\n\r\n"
            val out = ssl.outputStream
            out.write(head.toByteArray(Charsets.ISO_8859_1) + msg)
            out.flush()
            val resp = Http1.read(ssl.inputStream.buffered())
            if (resp.status != 200) throw IOException("HTTP ${resp.status}")
            if (resp.body.size < 12) throw IOException("bad body")
            ssl.close()
            return resp.body
        } finally {
            try { raw.close() } catch (_: IOException) {}
        }
    }
}

/* Races `attempt` over the routes in waves: the first alone, two more after
 * SECOND_WAVE_MS, then WAVE_SIZE more every NEXT_WAVE_MS from THIRD_WAVE_MS;
 * and the next one at once whenever nothing is in flight. The first answer
 * wins; null when every route failed or answerBy (System.nanoTime() in
 * milliseconds) came. Attempts still queued when the race ends are not made.
 * One the executor refuses (its queue is full) counts as failed at once: it
 * is never in flight, so nothing waits for it. */
fun race(
    plan: List<DohRoute>,
    executor: java.util.concurrent.Executor,
    timing: LongArray = longArrayOf(DohForwarder.SECOND_WAVE_MS, DohForwarder.THIRD_WAVE_MS, DohForwarder.NEXT_WAVE_MS),
    answerBy: Long = Long.MAX_VALUE,
    attempt: (DohRoute) -> ByteArray,
): Pair<DohRoute, ByteArray>? {
    if (plan.isEmpty()) return null
    val done = AtomicBoolean(false)
    try {
        return raceUntil(plan, executor, timing, answerBy, done, attempt)
    } finally {
        done.set(true)
    }
}

private fun raceUntil(
    plan: List<DohRoute>,
    executor: java.util.concurrent.Executor,
    timing: LongArray,
    answerBy: Long,
    done: AtomicBoolean,
    attempt: (DohRoute) -> ByteArray,
): Pair<DohRoute, ByteArray>? {
    val results = LinkedBlockingQueue<Pair<DohRoute, ByteArray?>>()
    var started = 0
    var pending = 0
    fun upTo(n: Int) {
        while (started < minOf(n, plan.size)) {
            val r = plan[started++]
            try {
                executor.execute {
                    if (done.get()) {
                        results.put(r to null)
                        return@execute
                    }
                    val got = try { attempt(r) } catch (_: Exception) { null }
                    results.put(r to got)
                }
                pending++
            } catch (_: RejectedExecutionException) {
            }
        }
    }
    /* Starts up to n, then one more for as long as nothing is in flight. */
    fun launch(n: Int) {
        upTo(n)
        while (pending == 0 && started < plan.size) upTo(started + 1)
    }
    val t0 = System.nanoTime() / 1_000_000
    // Long enough for every route to have its own timeout run out, unless
    // whoever asked stops waiting before that.
    val deadline = minOf(answerBy, t0 + DohForwarder.QUERY_TIMEOUT_MS * 2L + timing[1] + timing[2] * (plan.size / DohForwarder.WAVE_SIZE + 1))
    var stage = 0
    var nextAt = t0 + timing[0]
    launch(1)
    while (true) {
        if (pending == 0) return null    // every route refused or failed
        val now = System.nanoTime() / 1_000_000
        if (now >= deadline) return null
        if (started < plan.size && now >= nextAt) {
            if (stage == 0) {
                launch(3); stage = 1; nextAt = t0 + timing[1]
            } else {
                launch(started + DohForwarder.WAVE_SIZE); nextAt = now + timing[2]
            }
            continue
        }
        val wait = (if (started < plan.size) nextAt else deadline) - now
        val res = results.poll(maxOf(1L, wait), TimeUnit.MILLISECONDS) ?: continue
        pending--
        val answer = res.second
        if (answer != null) return res.first to answer
        // A route that fails fast does not hold up the rest.
        if (pending == 0) launch(started + 1)
    }
}

/* A server failure (SERVFAIL) in a race of the built-in routes: the
 * resolver could not get an answer it trusts, mostly for a name whose DNSSEC
 * signatures are wrong, and the engine takes it as the answer (core/src/doh.c).
 * One operator's could also be its own passing trouble, so it is the answer
 * once a second operator agrees (take), or when no route has anything better
 * (held). */
class FailureVote {
    private val ops = HashSet<String>()
    @Volatile var held: ByteArray? = null
        private set

    /* a, or an IOException (the race goes on) while one operator alone
     * has said the server failed. */
    @Synchronized
    fun take(r: DohRoute, a: ByteArray): ByteArray {
        if (!Dns.serverFailed(a)) return a
        if (held == null) held = a
        ops.add(r.op.removeSuffix("-front"))
        if (ops.size < 2) throw IOException("server failure")
        return a
    }
}

/* A SOCKS5 CONNECT to an IPv4 address or a name, with the engine's
 * password (RFC 1929) when it has one, or the user's own proxy login (#58). */
object Socks5 {
    private val IPV4 = Regex("^\\d{1,3}(\\.\\d{1,3}){3}$")

    fun hello(auth: SocksAuth?): ByteArray = hello(auth != null)

    private fun hello(login: Boolean): ByteArray = if (login) byteArrayOf(5, 1, 2) else byteArrayOf(5, 1, 0)

    fun login(auth: SocksAuth): ByteArray = login(auth.user, auth.pass)

    fun login(user: String, pass: String): ByteArray {
        val u = user.toByteArray(Charsets.UTF_8)
        val p = pass.toByteArray(Charsets.UTF_8)
        if (u.size > 255 || p.size > 255) throw IOException("SOCKS user name or password too long")
        return byteArrayOf(1, u.size.toByte()) + u + byteArrayOf(p.size.toByte()) + p
    }

    fun request(host: String, port: Int): ByteArray {
        val p = byteArrayOf((port shr 8).toByte(), port.toByte())
        if (IPV4.matches(host)) {
            val a = host.split('.').map { it.toInt() }
            require(a.all { it in 0..255 }) { "bad address $host" }
            return byteArrayOf(5, 1, 0, 1) + a.map { it.toByte() }.toByteArray() + p
        }
        // An IPv6 address as such (a literal: no lookup is made).
        if (host.contains(':')) return byteArrayOf(5, 1, 0, 4) + java.net.InetAddress.getByName(host).address + p
        val n = host.toByteArray(Charsets.US_ASCII)
        require(n.size in 1..255) { "bad name" }
        return byteArrayOf(5, 1, 0, 3, n.size.toByte()) + n + p
    }

    /* The greeting, and the password when there is one: what a SOCKS5
     * server answers before any request. Throws unless it accepted. */
    fun greet(s: Socket, auth: SocksAuth? = null) = greetWith(s, auth?.let { it.user to it.pass })

    /* With a user name and password of any kind, not only the engine's. */
    fun greetWith(s: Socket, cred: Pair<String, String>?) {
        val out = s.getOutputStream()
        val input = s.getInputStream()
        out.write(hello(cred != null))
        out.flush()
        val reply = ByteArray(2)
        readFully(input, reply)
        val method = if (cred != null) 2 else 0
        if (reply[0].toInt() != 5 || reply[1].toInt() != method) throw IOException("SOCKS refused")
        if (cred != null) {
            out.write(login(cred.first, cred.second))
            out.flush()
            val ok = ByteArray(2)
            readFully(input, ok)
            if (ok[1].toInt() != 0) throw IOException("SOCKS password refused")
        }
    }

    fun connect(s: Socket, host: String, port: Int, auth: SocksAuth? = null) = connectWith(s, host, port, auth?.let { it.user to it.pass })

    fun connectWith(s: Socket, host: String, port: Int, cred: Pair<String, String>?) {
        greetWith(s, cred)
        val out = s.getOutputStream()
        val input = s.getInputStream()
        out.write(request(host, port))
        out.flush()
        val head = ByteArray(5)
        readFully(input, head)
        if (head[1].toInt() != 0) throw IOException("SOCKS connect failed (${head[1]})")
        val rest = when (head[3].toInt()) {
            1 -> 10 - 5
            4 -> 22 - 5
            3 -> 7 + (head[4].toInt() and 0xff) - 5
            else -> throw IOException("SOCKS bad reply")
        }
        readFully(input, ByteArray(rest))
    }

    private fun readFully(input: java.io.InputStream, b: ByteArray) {
        var got = 0
        while (got < b.size) {
            val r = input.read(b, got, b.size - got)
            if (r < 0) throw IOException("SOCKS closed")
            got += r
        }
    }
}
