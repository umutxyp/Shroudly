package me.codeshare.shroudly

/*
 * The VPN interface and hev-socks5-tunnel's settings for it.
 *
 * Every app's packets arrive on the interface; hev turns their TCP (and UDP)
 * back into connections and hands them to the engine's SOCKS5 port. DNS is
 * answered inside hev ("mapdns"): an app asking for example.com gets a stand-in
 * address from MAPPED_NETWORK, and when it connects there, hev asks the engine
 * for example.com by name. So the engine sees every site's name, resolves it
 * over its own encrypted DNS, and can choose a technique per site, exactly as
 * with the desktop's system proxy.
 *
 * Every address here is in 198.18.0.0/15, the benchmarking range (RFC 2544),
 * which no real host uses: the interface and the DNS in 198.18.0.0/16, the
 * stand-in addresses in 198.19.0.0/16. A stale stand-in address can never
 * reach a real host, as one from carrier NAT space (100.64.0.0/10) could.
 *
 * hev hands stand-in addresses out in order from the start of its range, and
 * a new hev (a new session, or the tunnel restarted) starts again from the
 * first. Apps keep the addresses they were given for a while (Chrome for a
 * minute, Java's resolver for 30 seconds), so with one range an address an
 * app kept for one site would soon be given to another, and the app would
 * reach the wrong site. So each hev gets the next of MAPPED_RANGES: an
 * address from before is in none of the new hev's names, the engine refuses
 * it at once (--fake-net), and the app looks the name up again.
 */
object TunnelConfig {
    const val ADDRESS_V4 = "198.18.0.1"
    const val ADDRESS_V6 = "fc00::1"
    // The DNS server the VPN hands to apps; hev answers it itself.
    const val DNS_V4 = "198.18.0.2"
    const val MAPPED_NETWORK = "198.19.0.0"
    /* 198.19.0.0/16 in four: 16384 addresses each, more than CACHE_SIZE. */
    val MAPPED_RANGES = listOf("198.19.0.0", "198.19.64.0", "198.19.128.0", "198.19.192.0")
    const val MAPPED_NETMASK = "255.255.192.0"
    // How many names hev keeps a stand-in address for at once.
    const val CACHE_SIZE = 10000
    // hev's own recommendation for a VPN interface (fewer, larger packets).
    const val MTU = 8500
    // Below the engine's own connection cap (MAX_CONNS 2048), so the engine
    // keeps room for its encrypted DNS and the update check.
    const val MAX_SESSIONS = 1800
    // In a 32-bit process, which the engine now shares (a thread with a
    // 256 KB stack per connection, and hev's 84 KB per session), fewer: the
    // address space is 4 GB for everything the app does.
    const val MAX_SESSIONS_32 = 600
    // How long an app's connection may carry nothing before hev ends it.
    // hev's own 5 minutes ended the quiet connections that chat apps and
    // push notifications keep open to be told of a new message (Instagram's
    // messages, WhatsApp, Telegram, Google's push channel with its ~28
    // minute heartbeat): the next message then waited until the app noticed
    // and connected again ("messages go late, or not at all"). An hour is
    // longer than any of their keepalives; a connection whose server is gone
    // is still ended by the engine's TCP keepalive. UDP: the engine's own
    // two minutes (UDP_IDLE_MS in core/src/engine.c), not hev's one, so a
    // quiet call or QUIC connection keeps its port.
    const val TCP_IDLE_MS = 3_600_000
    const val UDP_IDLE_MS = 120_000

    /* The range for the hev started `generation`-th (any number; it wraps). */
    fun mappedNetwork(generation: Int): String = MAPPED_RANGES[Math.floorMod(generation, MAPPED_RANGES.size)]

    /* `user` and `pass` are the engine's per-session SOCKS5 credentials, or
     * null when the engine takes none. */
    fun yaml(
        socksPort: Int,
        udp: Boolean = true,
        user: String? = null,
        pass: String? = null,
        mapped: String = MAPPED_RANGES[0],
        maxSessions: Int = MAX_SESSIONS,
    ): String {
        require(maxSessions in 1..MAX_SESSIONS) { "bad session cap $maxSessions" }
        require(mapped in MAPPED_RANGES) { "bad stand-in range $mapped" }
        require(socksPort in 1..65535) { "bad port $socksPort" }
        require((user == null) == (pass == null)) { "both or neither of user and password" }
        for (s in listOfNotNull(user, pass)) require(SocksAuth.isToken(s)) { "bad credential" }
        val auth = if (user != null) "|  username: '$user'\n|  password: '$pass'\n" else ""
        // mapdns answers A queries with a stand-in address for any name, real
        // or not, and every other type with an empty answer: by design, see above.
        return """
            |tunnel:
            |  mtu: $MTU
            |socks5:
            |  port: $socksPort
            |  address: 127.0.0.1
            |  udp: '${if (udp) "udp" else "tcp"}'
            ${auth}|mapdns:
            |  address: $DNS_V4
            |  port: 53
            |  network: $mapped
            |  netmask: $MAPPED_NETMASK
            |  cache-size: $CACHE_SIZE
            |misc:
            |  task-stack-size: 86016
            |  connect-timeout: 10000
            |  tcp-read-write-timeout: $TCP_IDLE_MS
            |  udp-read-write-timeout: $UDP_IDLE_MS
            |  max-session-count: $maxSessions
            |  log-level: warn
            |""".trimMargin()
    }
}
