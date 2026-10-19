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
 */
object TunnelConfig {
    const val ADDRESS_V4 = "198.18.0.1"
    const val ADDRESS_V6 = "fc00::1"
    // The DNS server the VPN hands to apps; hev answers it itself.
    const val DNS_V4 = "198.18.0.2"
    const val MAPPED_NETWORK = "198.19.0.0"
    const val MAPPED_NETMASK = "255.255.0.0"
    // hev's own recommendation for a VPN interface (fewer, larger packets).
    const val MTU = 8500
    // Below the engine's own connection cap (MAX_CONNS 2048), so the engine
    // keeps room for its encrypted DNS and the update check.
    const val MAX_SESSIONS = 1800

    /* `user` and `pass` are the engine's per-session SOCKS5 credentials, or
     * null when the engine takes none. */
    fun yaml(socksPort: Int, udp: Boolean = true, user: String? = null, pass: String? = null): String {
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
            |  network: $MAPPED_NETWORK
            |  netmask: $MAPPED_NETMASK
            |  cache-size: 10000
            |misc:
            |  task-stack-size: 86016
            |  connect-timeout: 10000
            |  max-session-count: $MAX_SESSIONS
            |  log-level: warn
            |""".trimMargin()
    }
}
