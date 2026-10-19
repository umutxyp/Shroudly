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
 */
object TunnelConfig {
    const val ADDRESS_V4 = "198.18.0.1"
    const val ADDRESS_V6 = "fc00::1"
    // The DNS server the VPN hands to apps; hev answers it itself.
    const val DNS_V4 = "198.18.0.2"
    const val MAPPED_NETWORK = "100.64.0.0"
    const val MAPPED_NETMASK = "255.192.0.0"
    // hev's own recommendation for a VPN interface (fewer, larger packets).
    const val MTU = 8500

    fun yaml(socksPort: Int, udp: Boolean = true): String {
        require(socksPort in 1..65535) { "bad port $socksPort" }
        return """
            |tunnel:
            |  mtu: $MTU
            |socks5:
            |  port: $socksPort
            |  address: 127.0.0.1
            |  udp: '${if (udp) "udp" else "tcp"}'
            |mapdns:
            |  address: $DNS_V4
            |  port: 53
            |  network: $MAPPED_NETWORK
            |  netmask: $MAPPED_NETMASK
            |  cache-size: 10000
            |misc:
            |  task-stack-size: 86016
            |  connect-timeout: 10000
            |  log-level: warn
            |""".trimMargin()
    }
}
